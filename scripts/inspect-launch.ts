import {PublicKey,VersionedTransaction,TransactionMessage} from '@solana/web3.js';
import {db} from '../lib/db';
import {rpc,treasury} from '../lib/chain';
const p=db();
try {
 console.log('Treasury SOL lamports',await rpc().getBalance(treasury()));
 const attempts=(await p.query("SELECT id,wallet,mint,transaction_base64 FROM artemi_attempts WHERE kind='setup' ORDER BY created_at DESC LIMIT 3")).rows;
 for(const a of attempts){
  const table=(await rpc().getAddressLookupTable(new PublicKey(a.mint),{commitment:'finalized'})).value;
  const signatures=await rpc().getSignaturesForAddress(new PublicKey(a.mint),{limit:3},'finalized');
  const original=VersionedTransaction.deserialize(Buffer.from(a.transaction_base64,'base64'));
  const summarize=(m:ReturnType<typeof TransactionMessage.decompile>)=>({payer:m.payerKey.toBase58(),blockhash:m.recentBlockhash,instructions:m.instructions.map(i=>({program:i.programId.toBase58(),accounts:i.keys.map(k=>({address:k.pubkey.toBase58(),signer:k.isSigner,writable:k.isWritable})),data:i.data.toString('hex')}))});
  console.log(JSON.stringify({attempt:a.id,table:a.mint,exists:!!table,active:table?.isActive(),authority:table?.state.authority?.toBase58(),addresses:table?.state.addresses.length,signatures:signatures.map(s=>({signature:s.signature,err:s.err})),original:summarize(TransactionMessage.decompile(original.message))}));
  for(const s of signatures){const chain=await rpc().getTransaction(s.signature,{commitment:'finalized',maxSupportedTransactionVersion:0});if(chain)console.log(JSON.stringify({signature:s.signature,actual:summarize(TransactionMessage.decompile(chain.transaction.message)),err:chain.meta?.err}));}
 }
}finally{await p.end();}
