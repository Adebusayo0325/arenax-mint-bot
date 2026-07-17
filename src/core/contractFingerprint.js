const { ethers } = require('ethers');
const { getProvider } = require('../utils/rpcManager');
const logger = require('../utils/logger');
function sel(sig) { return ethers.id(sig).slice(0,10); }
const MINT_SELECTORS = new Map([
  [sel('publicMint(uint256)'),{name:'publicMint',args:['uint256']}],
  [sel('mintPublic(uint256)'),{name:'mintPublic',args:['uint256']}],
  [sel('mint(uint256)'),{name:'mint',args:['uint256']}],
  [sel('mint(address,uint256)'),{name:'mint',args:['address','uint256']}],
  [sel('mintTo(address,uint256)'),{name:'mintTo',args:['address','uint256']}],
  [sel('buy(uint256)'),{name:'buy',args:['uint256']}],
  [sel('purchase(uint256)'),{name:'purchase',args:['uint256']}],
  [sel('claim(uint256)'),{name:'claim',args:['uint256']}],
  [sel('mint()'),{name:'mint',args:[]}],
  [sel('publicMint()'),{name:'publicMint',args:[]}],
  [sel('claim()'),{name:'claim',args:[]}],
  [sel('publicMint(uint256,bytes32[])'),{name:'publicMint',args:['uint256','bytes32[]'],needsProof:true}],
  [sel('mintAllowList(uint256,bytes32[])'),{name:'mintAllowList',args:['uint256','bytes32[]'],needsProof:true}],
]);
const IMPL_SLOT='0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc';
async function resolveProxy(addr,provider) {
  try { const s=await provider.getStorage(addr,IMPL_SLOT); const a='0x'+s.slice(-40); if(!/^0x0+$/.test(a)) return a; } catch {}
  return null;
}
function extractSelectors(bytecode) {
  const out=new Set(); if(!bytecode||bytecode.length<10) return out;
  const b=Buffer.from(bytecode.replace('0x',''),'hex');
  for(let i=0;i<b.length;) { const op=b[i]; if(op===0x63&&i+4<b.length){out.add('0x'+b.slice(i+1,i+5).toString('hex'));i+=5;} else if(op>=0x60&&op<=0x7f){i+=op-0x60+2;} else i++; }
  return out;
}
async function fingerprintContract(contractAddress, chainId=1) {
  try {
    const provider=await getProvider(chainId);
    const impl=await resolveProxy(contractAddress,provider);
    const target=impl||contractAddress;
    const bytecode=await provider.getCode(target);
    if(!bytecode||bytecode==='0x') return {functions:[],isProxy:!!impl,implementation:impl};
    const found=extractSelectors(bytecode);
    const fns=[];
    for(const [s,info] of MINT_SELECTORS) if(found.has(s)) fns.push({selector:s,...info});
    fns.sort((a,b)=>(a.needsProof?1:0)-(b.needsProof?1:0));
    logger.info(`[Fingerprint] ${contractAddress.slice(0,10)}: ${fns.map(f=>f.name).join(',')||'no mint fns'}`);
    return {functions:fns,isProxy:!!impl,implementation:impl};
  } catch(e) { logger.warn(`[Fingerprint] ${e.message.slice(0,80)}`); return {functions:[],isProxy:false,implementation:null,error:e.message}; }
}
module.exports = { fingerprintContract, resolveProxy, MINT_SELECTORS };
