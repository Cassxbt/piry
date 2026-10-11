import unittest

from scripts.preflight import address_word, run_preflight, uint_word


def word(value):
    return '0x' + format(value, '064x')


class FakeRPC:
    def __init__(self, chain=10143, missing_code=False, registered=True):
        self.chain = chain
        self.missing_code = missing_code
        self.registered = registered
        self.calls = []

    def __call__(self, method, params):
        self.calls.append((method, params))
        if method == 'eth_chainId':
            return hex(self.chain)
        if method == 'eth_getBlockByNumber':
            return {'number': '0x42', 'hash': '0x' + 'ab' * 32}
        if method == 'eth_getCode':
            return '0x' if self.missing_code else '0x6000'
        if method == 'eth_getStorageAt':
            return word(0x22)
        if method == 'eth_call':
            data = params[0]['data']
            if data.startswith('0x23681a9a'):
                return word(0x11)
            if data.startswith('0x313ce567'):
                return word(6)
            return word(int(self.registered))
        raise AssertionError(method)


def manifest():
    return {
        'chain_id': 10143,
        'contracts': {'account_core': '0x' + '00' * 19 + '11',
                      'router': '0x' + '00' * 19 + '33'},
        'implementations': {'router': '0x' + '00' * 19 + '22'},
        'market': '0x' + '00' * 19 + '44',
        'quote_token': '0x' + '00' * 19 + '55',
        'quote_decimals': 6,
        'bounty_faucet_quote_token': '0x' + '00' * 19 + '66',
    }


class PreflightTests(unittest.TestCase):
    def test_wrong_network_stops_before_contract_reads(self):
        rpc = FakeRPC(chain=143)
        with self.assertRaisesRegex(ValueError, 'chain'):
            run_preflight(rpc, manifest())
        self.assertEqual(len(rpc.calls), 1)

    def test_all_state_reads_are_pinned(self):
        rpc = FakeRPC()
        report = run_preflight(rpc, manifest())
        for method, params in rpc.calls:
            if method in {'eth_getCode', 'eth_getStorageAt', 'eth_call'}:
                self.assertEqual(params[-1], '0x42')
        self.assertTrue(report['baseline_checks_passed'])

    def test_baseline_never_proves_custom_listing_or_trade(self):
        report = run_preflight(FakeRPC(), manifest())
        self.assertFalse(report['custom_market_ready'])
        self.assertFalse(report['trade_proven'])

    def test_missing_code_fails_baseline(self):
        report = run_preflight(FakeRPC(missing_code=True), manifest())
        self.assertFalse(report['baseline_checks_passed'])

    def test_unregistered_market_fails_baseline(self):
        report = run_preflight(FakeRPC(registered=False), manifest())
        self.assertFalse(report['baseline_checks_passed'])

    def test_changed_implementation_fails_baseline(self):
        config = manifest()
        config['implementations']['router'] = '0x' + '00' * 19 + '99'
        self.assertFalse(run_preflight(FakeRPC(), config)['baseline_checks_passed'])

    def test_faucet_address_difference_is_not_hidden(self):
        report = run_preflight(FakeRPC(), manifest())
        self.assertFalse(report['faucet_quote_matches_deployment'])

    def test_malformed_or_empty_abi_result_rejected(self):
        for value in ['0x', '0x01', '0x' + 'gg' * 32]:
            with self.assertRaises(ValueError):
                uint_word(value)

    def test_address_encoding_rejects_invalid_input(self):
        with self.assertRaises(ValueError):
            address_word('not-an-address')
        self.assertEqual(len(address_word('0x' + '11' * 20)), 64)


if __name__ == '__main__':
    unittest.main()
