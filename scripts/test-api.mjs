import {Keypair} from '@solana/web3.js';
import nacl from 'tweetnacl';
import assert from 'node:assert/strict';
const base=process.argv[2]||'http://localhost:3000';const key=Keypair.generate(),wallet=key.publicKey.toBase58();let cookie='';
async function request(path,body,origin=base){const response=await fetch(base+'/api/'+path,{method:body===undefined?'GET':'POST',headers:{...(body instanceof FormData?{}:{'Content-Type':'application/json'}),Origin:origin,...(cookie?{Cookie:cookie}:{})},body:body===undefined?undefined:body instanceof FormData?body:JSON.stringify(body)});let j;try{j=await response.json();}catch{throw new Error(`${path} returned non-JSON ${response.status}`);}return {status:response.status,j,headers:response.headers};}
assert.equal((await request('wallet/activity')).status,401);
const challenge=await request('auth/challenge',{wallet});assert.equal(challenge.status,200);
const invalid=await request('auth/verify',{id:challenge.j.id,signature:Buffer.alloc(64).toString('base64')});assert.equal(invalid.status,401);
const signature=Buffer.from(nacl.sign.detached(Buffer.from(challenge.j.message),key.secretKey)).toString('base64');
const verified=await request('auth/verify',{id:challenge.j.id,signature});assert.equal(verified.status,200);assert.match(verified.headers.get('set-cookie'),/HttpOnly/i);cookie=verified.headers.get('set-cookie').split(';')[0];
assert.equal((await request('auth/verify',{id:challenge.j.id,signature})).status,400);assert.equal((await request('auth/session')).j.wallet,wallet);
assert.equal((await request('launch/quote',{sol:'0.199999999'})).status,400);assert.equal((await request('launch/quote',{sol:'0.2'},'https://invalid.example')).status,403);
const q=await request('launch/quote',{sol:'0.2'});assert.equal(q.status,200);assert.equal(q.j.creatorTokens,'0');assert.equal(q.j.bags,Number(BigInt(q.j.treasuryTokens)/300000000000n));assert.equal(q.j.bags,23);const more=await request('launch/quote',{sol:'2'});assert.equal(more.status,200);assert.equal(more.j.treasuryTokens,q.j.treasuryTokens);assert.ok(BigInt(more.j.creatorTokens)>0n);
const single=await request('launch/quote',{sol:'1',version:1});assert.equal(single.status,200);assert.equal(single.j.setupRequired,false);assert.equal(single.j.setupRent,'0');assert.equal(single.j.approvals,1);assert.equal(single.j.transactionVersion,1);
const form=new FormData();form.set('name','Security test');form.set('ticker','TEST');form.set('image',new File(['<svg/>'],'test.svg',{type:'image/svg+xml'}));assert.equal((await request('metadata',form)).status,400);
await request('auth/logout',{});assert.equal((await request('wallet/activity')).status,401);
console.log('PASS: deployed authentication, invalid signature, nonce replay, secure session, purchase minimum, fixed treasury allocation, CSRF, image rejection, and logout. No transactions broadcast.');
