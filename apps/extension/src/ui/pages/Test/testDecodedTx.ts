export const testDecodedTx = {
  code: 0,
  msg: 'ok',
  data: {
    inputInfos: [
      {
        txid: 'e19512fb8177cb676faa44390fc757ce78934bf6495d5a6a50736123994ded78',
        vout: 1,
        address: 'qbrt1zqqqsyqcyq5rqwzqfpg9scrgwpugpzysnzs23v9ccrydpk8qarc0s8kqqny',
        value: 50000,
        alkanes: [],
        onchain: true,
        height: 824479
      }
    ],
    outputInfos: [
      {
        address: 'qb1zqqqsyqcyq5rqwzqfpg9scrgwpugpzysnzs23v9ccrydpk8qarc0sjq57mw',
        value: 45000,
        alkanes: []
      }
    ],
    feeRate: '10.0',
    fee: 5000,
    isCompleted: true,
    risks: [
      {
        type: 8,
        level: 'warning',
        title: 'High fee rate detected',
        desc: 'The fee rate is much higher than recommended fee rate'
      }
    ],
    features: {
      rbf: false
    },
  }
};
