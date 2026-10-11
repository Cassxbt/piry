"""Read-only Kuru deployment checks. No wallet, signing or transactions."""

import argparse
from datetime import datetime, timezone
import hashlib
import json
from pathlib import Path
import re
import sys
import time
import urllib.request


IMPLEMENTATION_SLOT = '0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc'
READ_METHODS = {'eth_chainId', 'eth_getBlockByNumber', 'eth_getCode',
                'eth_getStorageAt', 'eth_call'}


def address_word(address):
    if not re.fullmatch(r'0x[0-9a-fA-F]{40}', address):
        raise ValueError('invalid address')
    return address[2:].lower().rjust(64, '0')


def uint_word(value):
    if not isinstance(value, str) or not re.fullmatch(r'0x[0-9a-fA-F]{64}', value):
        raise ValueError('invalid ABI word')
    return int(value, 16)


def rpc_client(url):
    def request(method, params):
        if method not in READ_METHODS:
            raise ValueError('only read-only RPC methods are permitted')
        payload = json.dumps({'jsonrpc': '2.0', 'id': 1,
                              'method': method, 'params': params}).encode()
        req = urllib.request.Request(url, data=payload,
                                     headers={'Content-Type': 'application/json'})
        time.sleep(0.12)
        with urllib.request.urlopen(req, timeout=20) as response:
            result = json.load(response)
        if result.get('id') != 1 or 'error' in result or 'result' not in result:
            raise ValueError(f'{method}: invalid response or RPC error')
        return result['result']
    return request


def run_preflight(rpc, config):
    chain = int(rpc('eth_chainId', []), 16)
    if chain != config['chain_id']:
        raise ValueError(f'wrong chain: expected {config["chain_id"]}, got {chain}')
    snapshot = rpc('eth_getBlockByNumber', ['finalized', False])
    if not snapshot or not snapshot.get('number') or not snapshot.get('hash'):
        raise ValueError('finalized snapshot unavailable; no latest-block fallback')
    block = snapshot['number']
    checks = []

    def check(name, actual, expected):
        checks.append({'name': name, 'actual': actual, 'expected': expected,
                       'passed': actual == expected})

    contracts = config['contracts']
    targets = {**contracts, 'known_market': config['market'],
               'quote_token': config['quote_token']}
    code_evidence = {}
    for name, address in targets.items():
        address_word(address)
        code = rpc('eth_getCode', [address, block])
        raw = bytes.fromhex(code.removeprefix('0x'))
        code_evidence[name] = {'address': address, 'bytes': len(raw),
                               'sha256': hashlib.sha256(raw).hexdigest()}
        check(f'{name}:code_present', len(raw) > 0, True)

    for name, expected in config['implementations'].items():
        actual = rpc('eth_getStorageAt', [targets[name], IMPLEMENTATION_SLOT, block])
        check(f'{name}:implementation', uint_word(actual), int(expected, 16))

    def call(address, selector, arg=None):
        data = selector + (address_word(arg) if arg else '')
        return uint_word(rpc('eth_call', [{'to': address, 'data': data}, block]))

    # Selectors independently generated with cast sig from these documented signatures.
    check('router:verifiedSpotMarket',
          call(contracts['router'], '0xb724101d', config['market']), 1)
    check('account_core:verifiedSpotOrderBook',
          call(contracts['account_core'], '0x6b7b5374', config['market']), 1)
    check('router:spotBalanceAccountAddress',
          call(contracts['router'], '0x23681a9a'), int(contracts['account_core'], 16))
    check('router:quote_token_whitelisted',
          call(contracts['router'], '0xe1866ca1', config['quote_token']), 1)
    check('quote_token:decimals',
          call(config['quote_token'], '0x313ce567'), config['quote_decimals'])
    faucet_whitelisted = call(contracts['router'], '0xe1866ca1',
                              config['bounty_faucet_quote_token'])
    confirmed = rpc('eth_getBlockByNumber', [block, False])
    check('snapshot:hash_unchanged', confirmed['hash'], snapshot['hash'])
    return {
        'observed_at_utc': datetime.now(timezone.utc).isoformat(),
        'chain_id': chain, 'block_number': int(block, 16), 'block_hash': snapshot['hash'],
        'baseline_checks_passed': all(c['passed'] for c in checks),
        'custom_market_ready': False, 'trade_proven': False,
        'faucet_quote_matches_deployment': config['quote_token'].lower()
            == config['bounty_faucet_quote_token'].lower(),
        'bounty_faucet_quote_whitelisted': faucet_whitelisted == 1,
        'checks': checks, 'code_evidence': code_evidence,
        'limits': ['Read-only existing-market baseline; no custom asset was registered.',
                   'No orders, fills, liquidity, withdrawal capacity or settlement tested.',
                   'Proxy code presence and implementation pointers are not a security audit.',
                   'Custom listing permission and sponsor acceptance remain unresolved.'],
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--rpc-url', default='https://testnet-rpc.monad.xyz')
    parser.add_argument('--output', default='evidence/kuru-preflight.json')
    args = parser.parse_args()
    root = Path(__file__).resolve().parents[1]
    config = json.loads((root / 'config/kuru-testnet.json').read_text())
    try:
        report = run_preflight(rpc_client(args.rpc_url), config)
    except (OSError, ValueError, KeyError, TypeError) as error:
        print(f'Preflight incomplete: {type(error).__name__}: {error}', file=sys.stderr)
        return 1
    destination = Path(args.output)
    destination.parent.mkdir(parents=True, exist_ok=True)
    destination.write_text(json.dumps(report, indent=2) + '\n')
    print(json.dumps({key: report[key] for key in
                     ['block_number', 'baseline_checks_passed',
                      'custom_market_ready', 'trade_proven']}))
    return 0 if report['baseline_checks_passed'] else 1


if __name__ == '__main__':
    sys.exit(main())
