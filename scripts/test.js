const { keccak256, toBytes } = require('viem');
const sigs = [
  'NotWhiteListed(address)', 'NotWhitelisted()', 'NotAgent()', 'NotAnAgent()',
  'AgentRequired()', 'SpenderNotAgent()', 'WhitelistEnabled()',
  'IsWhiteListEnabled()', 'Unauthorized(address)', 'Forbidden()',
  'ERC20InsufficientAllowance(address,uint256,uint256)',
  'ERC20InvalidSpender(address)'
];
sigs.forEach(s => console.log(keccak256(toBytes(s)).slice(0, 10), s));
