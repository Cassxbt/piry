import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { keccak256, toBytes } from 'viem';

// Drives scripts/keeper.sh against stubbed `cast`, `cre` and `flock`. No key, network or chain is involved: the stubs
// serve chain state from files and apply a scenario's "effect" when a broadcast runs.
const keeper = join(import.meta.dirname, '../../scripts/keeper.sh');
const viem = import.meta.resolve('viem');
const END = 1_792_411_200;
const NOW = END - 3600;
const FEED_HASH = (round: number) => `0x${round.toString(16).padStart(64, 'a')}`;
const evidence = (tag: string) => {
  const json = `{"methodology":"composite-median-v1","observedAt":${NOW},"sources":{},"specHash":"${tag}"}`;
  return { json, hash: keccak256(toBytes(json)) };
};

const castStub = `#!/bin/bash
echo "cast $*" >> "$FAKE/calls.log"
case "$1" in
  call)
    if [ -e "$FAKE/rpc.down" ] || grep -qxF "$3" "$FAKE/fail" 2>/dev/null; then echo "Error: rpc unavailable" >&2; exit 1; fi
    if [ -f "$FAKE/lag" ]; then
      reads=$(cat "$FAKE/lag")
      if [ "$reads" -le 0 ]; then . "$FAKE/lag.apply"; rm -f "$FAKE/lag" "$FAKE/lag.apply"; else echo $((reads - 1)) > "$FAKE/lag"; fi
    fi
    case "$3" in
      "settled()(bool)") cat "$FAKE/settled" ;;
      "latestRound()(uint80)") cat "$FAKE/latestRound" ;;
      "rounds(uint80)(int256,uint256,uint64,bytes32)") cat "$FAKE/round.$4" ;;
      "settlementEvidenceHash()(bytes32)") cat "$FAKE/settlementEvidenceHash" ;;
      *) echo "unexpected call $3" >&2; exit 1 ;;
    esac ;;
  keccak) ${process.execPath} -e "import { keccak256 } from '${viem}'; console.log(keccak256(new TextEncoder().encode(await Bun.stdin.text())))" ;;
  *) echo "unexpected cast $1" >&2; exit 1 ;;
esac
`;
const creStub = `#!/bin/bash
while [ $# -gt 0 ]; do case "$1" in --trigger-index) trigger=$2; shift ;; --broadcast) mode=broadcast ;; esac; shift; done
mode=\${mode:-dry}
echo "cre trigger=$trigger mode=$mode key=\${CRE_ETH_PRIVATE_KEY:+set}" >> "$FAKE/calls.log"
cat "$FAKE/cre.$trigger.$mode.out"
[ -f "$FAKE/cre.$trigger.$mode.effect" ] && . "$FAKE/cre.$trigger.$mode.effect"
exit "$(cat "$FAKE/cre.$trigger.$mode.rc" 2>/dev/null || echo 0)"
`;
const flockStub = `#!/bin/bash
[ -z "\${FAKE_LOCKED:-}" ]
`;

const markLine = (price: number | string) =>
  `2026-10-13T21:31:32Z [USER LOG] COMPOSITE mark simulation: composite-median-v1; price=${price}; slots=4; observedAt=1; evidence=0x1; payload=0x2`;
const evidenceLine = ({ hash, json }: { hash: string; json: string }) => `2026-10-13T21:31:32Z [USER LOG] PIRY_EVIDENCE ${hash} ${json}`;
const annotated = (value: number | string) => (String(value).length > 4 && !String(value).startsWith('0x') ? `${value} [${Number(value).toExponential(3)}]` : String(value));

type Rig = ReturnType<typeof rig>;
function rig(options: { now?: number; settled?: boolean; round?: number; price?: number; updatedAt?: number } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'piry-keeper-'));
  const fake = join(root, 'fake');
  for (const dir of ['scripts', 'deployments', 'workflow', 'evidence', 'bin', 'fake']) mkdirSync(join(root, dir));
  copyFileSync(keeper, join(root, 'scripts/keeper.sh'));
  writeFileSync(join(root, '.env.deployer'), 'DEPLOYER_PRIVATE_KEY=0xnot-a-real-key\n');
  writeFileSync(join(root, 'deployments/monad-testnet.json'), JSON.stringify({
    contracts: { market: { address: '0xMarket' }, markFeed: { address: '0xFeed' } }, series: { periodEnd: END },
  }));
  for (const [name, body] of [['cast', castStub], ['cre', creStub], ['flock', flockStub]]) {
    writeFileSync(join(root, 'bin', name), body);
    chmodSync(join(root, 'bin', name), 0o755);
  }
  const put = (name: string, body: string) => writeFileSync(join(fake, name), `${body}\n`);
  const now = options.now ?? NOW;
  const self = {
    root, now,
    put,
    round(id: number, price: number, updatedAt: number, hash = FEED_HASH(id)) {
      put(`round.${id}`, [annotated(price * 13), annotated(price), annotated(updatedAt), hash].join('\n'));
    },
    chain(round = options.round ?? 100, price = options.price ?? 3_408_500, updatedAt = options.updatedAt ?? now - 300) {
      put('settled', String(options.settled ?? false));
      put('latestRound', String(round));
      self.round(round, price, updatedAt);
    },
    cre(trigger: number, mode: 'dry' | 'broadcast', out: string, rc = 0, effect?: string) {
      put(`cre.${trigger}.${mode}.out`, out);
      put(`cre.${trigger}.${mode}.rc`, String(rc));
      if (effect) put(`cre.${trigger}.${mode}.effect`, effect);
    },
    run(extra: Record<string, string> = {}) {
      const result = spawnSync('bash', [join(root, 'scripts/keeper.sh')], {
        encoding: 'utf8', env: { PATH: `${join(root, 'bin')}:/usr/bin:/bin`, HOME: root, FAKE: fake, PIRY_NOW: String(now), PIRY_POLL_SECONDS: '0', ...extra },
      });
      return { status: result.status, stderr: result.stderr, stdout: result.stdout };
    },
    read: (path: string) => readFileSync(join(root, path), 'utf8'),
    has: (path: string) => existsSync(join(root, path)),
    log: () => (existsSync(join(root, 'evidence/keeper.log')) ? readFileSync(join(root, 'evidence/keeper.log'), 'utf8') : ''),
    calls: () => (existsSync(join(fake, 'calls.log')) ? readFileSync(join(fake, 'calls.log'), 'utf8') : ''),
    broadcasts: () => self.calls().split('\n').filter(line => line.includes('mode=broadcast')).length,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
  self.chain();
  return self;
}

function withRig(options: Parameters<typeof rig>[0], body: (r: Rig) => void) {
  const r = rig(options);
  try { body(r); } finally { r.cleanup(); }
}

// A broadcast that lands the next round with the given accepted values.
const landing = (price: number, updatedAt: number, hash: string) =>
  `n=$(( $(cat "$FAKE/latestRound") + 1 )); echo $n > "$FAKE/latestRound"; ` +
  `printf '%s\\n' '${annotated(price * 13)}' '${annotated(price)}' '${annotated(updatedAt)}' '${hash}' > "$FAKE/round.$n"`;

test('skips the broadcast while the price is unchanged and the on-chain mark is fresh', () => {
  withRig({}, r => {
    r.cre(1, 'dry', markLine(3_408_500));
    const { status } = r.run();
    assert.equal(status, 0);
    assert.equal(r.broadcasts(), 0);
    assert.match(r.log(), /unchanged, on-chain mark 300s old; skipped/);
    assert(!r.has('evidence/keeper.state'));
  });
});

test('the heartbeat follows the on-chain updatedAt age, not a remembered timestamp', () => {
  for (const [age, broadcasts] of [[1199, 0], [1200, 1]] as const) {
    withRig({ updatedAt: NOW - age }, r => {
      const ev = evidence('0xaa');
      r.put('../evidence/keeper.state', `3408500 ${NOW} 100 ${FEED_HASH(100)}`);
      r.cre(1, 'dry', markLine(3_408_500));
      r.cre(1, 'broadcast', [markLine(3_408_500), evidenceLine(ev)].join('\n'), 0, landing(3_408_500, NOW - 20, ev.hash));
      assert.equal(r.run().status, 0, r.log());
      assert.equal(r.broadcasts(), broadcasts, `age ${age}`);
    });
  }
});

test('a landed mark stores the accepted on-chain price and updatedAt, its evidence bytes, and no temp file', () => {
  withRig({}, r => {
    const ev = evidence('0xbb');
    r.cre(1, 'dry', markLine(3_388_500));
    r.cre(1, 'broadcast', [markLine(3_388_500), evidenceLine(ev)].join('\n'), 0, landing(2_730_000, NOW - 40, ev.hash));
    assert.equal(r.run().status, 0, r.log());
    assert.equal(r.read('evidence/keeper.state'), `2730000 ${NOW - 40} 101 ${ev.hash}\n`);
    assert.equal(r.read(`evidence/composite/${ev.hash}.json`), ev.json);
    assert.deepEqual(readdirSync(join(r.root, 'evidence/composite')), [`${ev.hash}.json`]);
    assert(!r.has('evidence/keeper.state.tmp'));
    assert.match(r.log(), /mark landed: round 101 price=2730000 updatedAt=\d+ \(dry run said 3388500\)/);
  });
});

test('after a broadcast that landed a different price than the dry run, the next dry price is not suppressed', () => {
  withRig({}, r => {
    const ev = evidence('0xcc');
    r.cre(1, 'dry', markLine(3_388_500));
    r.cre(1, 'broadcast', [markLine(3_388_500), evidenceLine(ev)].join('\n'), 0, landing(2_730_000, NOW - 40, ev.hash));
    assert.equal(r.run().status, 0);
    assert.equal(r.broadcasts(), 1);
    assert.equal(r.run({ PIRY_NOW: String(NOW + 300) }).status, 0);
    assert.equal(r.broadcasts(), 2);
  });
});

test('a dry run that logged a price and then failed delivery authorizes nothing', () => {
  for (const [out, rc] of [
    [`${markLine(3_388_500)}\n✗ workflow execution failed: report delivery rejected`, 1],
    [`${markLine(3_388_500)}\nError: report delivery rejected`, 0],
    ['no price line here', 0],
  ] as const) {
    withRig({ updatedAt: NOW - 5000 }, r => {
      r.cre(1, 'dry', out, rc);
      assert.equal(r.run().status, 1);
      assert.equal(r.broadcasts(), 0);
      assert.match(r.log(), /ALERT dry run failed/);
    });
  }
});

// The chain answers with the old state for `reads` more reads after the broadcast, as a lagging RPC node would.
const lagging = (effect: string, reads: number) => `echo ${reads} > "$FAKE/lag"; cat > "$FAKE/lag.apply" <<'APPLY'\n${effect}\nAPPLY`;

test('a landing that the RPC reports a few reads late is still verified', () => {
  withRig({ updatedAt: NOW - 5000 }, r => {
    const ev = evidence('0x44');
    r.cre(1, 'dry', markLine(3_388_500));
    r.cre(1, 'broadcast', [markLine(3_388_500), evidenceLine(ev)].join('\n'), 0, lagging(landing(3_388_500, NOW - 20, ev.hash), 3));
    assert.equal(r.run().status, 0, r.log());
    assert.match(r.log(), /mark landed: round 101/);
  });
  withRig({ updatedAt: NOW - 5000 }, r => {
    const ev = evidence('0x55');
    r.cre(1, 'dry', markLine(3_388_500));
    r.cre(1, 'broadcast', [markLine(3_388_500), evidenceLine(ev)].join('\n'), 0, lagging(landing(3_388_500, NOW - 20, ev.hash), 9));
    assert.equal(r.run().status, 1);
    assert.match(r.log(), /ALERT mark broadcast did not land/);
  });
});

test('a broadcast that does not advance the feed is an alert and records no state', () => {
  withRig({ updatedAt: NOW - 5000 }, r => {
    r.cre(1, 'dry', markLine(3_388_500));
    r.cre(1, 'broadcast', markLine(3_388_500));
    assert.equal(r.run().status, 1);
    assert.match(r.log(), /ALERT mark broadcast did not land/);
    assert(!r.has('evidence/keeper.state'));
  });
});

test('a round that is not this run\'s mark is an alert and records nothing', () => {
  withRig({ updatedAt: NOW - 5000 }, r => {
    const ours = evidence('0xdd');
    r.cre(1, 'dry', markLine(3_388_500));
    r.cre(1, 'broadcast', [markLine(3_388_500), evidenceLine(ours)].join('\n'), 0, landing(3_388_500, NOW - 20, FEED_HASH(777)));
    assert.equal(r.run().status, 1);
    assert.match(r.log(), /ALERT round 101 is not this run's mark/);
    assert(!r.has('evidence/keeper.state'));
    assert.deepEqual(readdirSync(join(r.root, 'evidence/composite')), []);
  });
});

test('evidence that does not hash to the accepted evidence hash is not saved', () => {
  withRig({ updatedAt: NOW - 5000 }, r => {
    const ours = evidence('0xee');
    const forged = { json: `${ours.json.slice(0, -1)} }`, hash: ours.hash };
    r.cre(1, 'dry', markLine(3_388_500));
    r.cre(1, 'broadcast', [markLine(3_388_500), evidenceLine(forged)].join('\n'), 0, landing(3_388_500, NOW - 20, ours.hash));
    assert.equal(r.run().status, 1);
    assert.deepEqual(readdirSync(join(r.root, 'evidence/composite')), []);
    assert(!r.has('evidence/keeper.state'));
  });
});

test('an accepted mark whose updatedAt is too old is an alert and is not recorded', () => {
  withRig({ updatedAt: NOW - 5000 }, r => {
    const ev = evidence('0xff');
    r.cre(1, 'dry', markLine(3_388_500));
    r.cre(1, 'broadcast', [markLine(3_388_500), evidenceLine(ev)].join('\n'), 0, landing(3_388_500, NOW - 901, ev.hash));
    assert.equal(r.run().status, 1);
    assert.match(r.log(), /ALERT round 101 accepted with updatedAt 901s old/);
    assert(!r.has('evidence/keeper.state'));
  });
});

test('RPC failures and garbage answers are failures, never a skipped or successful run', () => {
  for (const [signature, expectedBroadcasts] of [
    ['settled()(bool)', 0], ['latestRound()(uint80)', 0], ['rounds(uint80)(int256,uint256,uint64,bytes32)', 0],
  ] as const) {
    withRig({}, r => {
      r.cre(1, 'dry', markLine(3_408_500));
      r.put('fail', signature);
      assert.equal(r.run().status, 1, signature);
      assert.match(r.log(), /ALERT RPC read failed/);
      assert.equal(r.broadcasts(), expectedBroadcasts);
    });
  }
  withRig({}, r => {
    r.cre(1, 'dry', markLine(3_408_500));
    r.put('latestRound', 'not-a-number');
    assert.equal(r.run().status, 1);
    assert.match(r.log(), /ALERT unexpected latestRound/);
  });
  withRig({}, r => {
    r.put('rpc.down', '');
    assert.equal(r.run().status, 1);
    assert.equal(r.broadcasts(), 0);
    assert.doesNotMatch(r.calls(), /cre trigger/);
  });
});

test('an RPC failure after the broadcast is a failure and leaves no state', () => {
  withRig({ updatedAt: NOW - 5000 }, r => {
    const ev = evidence('0x11');
    r.cre(1, 'dry', markLine(3_388_500));
    r.cre(1, 'broadcast', [markLine(3_388_500), evidenceLine(ev)].join('\n'), 0, `touch "$FAKE/rpc.down"`);
    assert.equal(r.run().status, 1);
    assert.match(r.log(), /ALERT RPC read failed/);
    assert(!r.has('evidence/keeper.state'));
  });
});

test('a missing key file is an alert, not a crash', () => {
  withRig({}, r => {
    rmSync(join(r.root, '.env.deployer'));
    assert.equal(r.run().status, 1);
    assert.match(r.log(), /ALERT \.env\.deployer is missing/);
    assert.equal(r.calls(), '');
  });
});

test('an overlapping run exits at once without reading or broadcasting', () => {
  withRig({}, r => {
    assert.equal(r.run({ FAKE_LOCKED: '1' }).status, 0);
    assert.equal(r.calls(), '');
    assert.match(r.log(), /previous run still active/);
  });
});

test('a settled market needs nothing', () => {
  withRig({ settled: true }, r => {
    assert.equal(r.run().status, 0);
    assert.doesNotMatch(r.calls(), /cre trigger/);
    assert.match(r.log(), /settled; nothing to do/);
  });
});

test('no key material reaches the keeper log', () => {
  withRig({ updatedAt: NOW - 5000 }, r => {
    const ev = evidence('0x33');
    r.cre(1, 'dry', markLine(3_388_500));
    r.cre(1, 'broadcast', [markLine(3_388_500), 'broadcast failed: using private key 0xnot-a-real-key', evidenceLine(ev)].join('\n'), 0,
      landing(3_388_500, NOW - 20, ev.hash));
    assert.equal(r.run().status, 0, r.log());
    assert.match(r.log(), /mark landed/);
    assert.doesNotMatch(r.log(), /not-a-real-key|private/i);
    assert.match(r.calls(), /key=set/);
  });
});

const settlementWindow = [['before the first eligible minute', END + 59, false], ['at the first eligible minute', END + 60, true],
  ['at the end of the window', END + 86400, true], ['after the window', END + 86401, false]] as const;
for (const [name, at, attempts] of settlementWindow) {
  test(`settlement is attempted only inside the window: ${name}`, () => {
    withRig({ now: at }, r => {
      r.cre(0, 'broadcast', '✗ workflow execution failed: settlement needs 4 valid sources until 14400s after expiry, got 3', 1);
      r.cre(1, 'dry', markLine(3_408_500));
      r.run();
      assert.equal(r.calls().includes('trigger=0'), attempts);
    });
  });
}

test('a settlement that lands is verified on chain, its evidence saved, and the run ends', () => {
  withRig({ now: END + 120 }, r => {
    const ev = evidence('0x22');
    r.cre(0, 'broadcast', ['2026-10-13T21:31:32Z [USER LOG] COMPOSITE simulation: price=2730000', evidenceLine(ev)].join('\n'), 0,
      `echo true > "$FAKE/settled"; echo ${ev.hash} > "$FAKE/settlementEvidenceHash"`);
    assert.equal(r.run().status, 0, r.log());
    assert.equal(r.read(`evidence/composite/${ev.hash}.json`), ev.json);
    assert.match(r.log(), /settled; evidence 0x[0-9a-f]+ saved/);
    assert.doesNotMatch(r.calls(), /trigger=1/);
  });
});

test('a quorum refusal is a deferral, not an alert, and marking continues', () => {
  withRig({ now: END + 120 }, r => {
    r.cre(0, 'broadcast', '✗ workflow execution failed: settlement needs 4 valid sources until 14400s after expiry, got 3', 1);
    r.cre(1, 'dry', markLine(3_408_500));
    assert.equal(r.run().status, 0);
    assert.match(r.log(), /settlement deferred/);
    assert.doesNotMatch(r.log(), /ALERT/);
    assert.match(r.calls(), /trigger=1 mode=dry/);
  });
});

test('any other settlement failure is an alert, and marking still continues', () => {
  for (const [out, rc] of [['✗ workflow execution failed: preflight: market specHash is 0x1 on chain, 0x2 configured', 1], ['simulation report produced', 0]] as const) {
    withRig({ now: END + 120 }, r => {
      r.cre(0, 'broadcast', out, rc);
      r.cre(1, 'dry', markLine(3_408_500));
      assert.equal(r.run().status, 1);
      assert.match(r.log(), /ALERT settlement did not land/);
      assert.match(r.calls(), /trigger=1 mode=dry/);
    });
  }
});
