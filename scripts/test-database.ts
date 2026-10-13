import {randomUUID} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import assert from 'node:assert/strict';
import pg from 'pg';
const base=new URL(process.env.NEON!);base.hostname=base.hostname.replace(/-pooler(?=\.)/,'');base.searchParams.set('sslmode','verify-full');const admin=new pg.Pool({connectionString:base.toString(),max:1});
const schema=`artemi_test_${randomUUID().replaceAll('-','')}`;
if(!/^artemi_test_[a-f0-9]{32}$/.test(schema))throw new Error('Unsafe test schema.');
await admin.query(`CREATE SCHEMA ${schema}`);
const pool=new pg.Pool({connectionString:base.toString(),max:4,options:`-c search_path=${schema}`});
try{
 for(const file of ['001_initial.sql','002_lookup.sql','003_launch_idempotency.sql'])await pool.query(await readFile(`migrations/${file}`,'utf8'));
 const mint='fixture',bag=randomUUID();await pool.query("INSERT INTO artemi_locations(id,name,region,lat,lng,source) VALUES('test','Test fixture','EU',0,0,'test')");
 await pool.query("INSERT INTO artemi_coins(mint,name,ticker,image,uri,creator,treasury_amount,decimals,launch_signature) VALUES($1,'Test','TEST','','','creator',200000000000,6,'fixture-signature')",[mint]);
 await pool.query("INSERT INTO artemi_bags(id,mint,location_id,amount) VALUES($1,$2,'test',100000000000)",[bag,mint]);
 const compete=async(wallet:string)=>{const c=await pool.connect();try{await c.query('BEGIN');const r=await c.query('SELECT status FROM artemi_bags WHERE id=$1 FOR UPDATE',[bag]);if(r.rows[0].status!=='available'){await c.query('ROLLBACK');return false;}await c.query("UPDATE artemi_bags SET status='reserved',claimant=$2 WHERE id=$1",[bag,wallet]);await c.query("INSERT INTO artemi_attempts(id,kind,wallet,mint,bag_id,status,message,transaction_base64,last_valid_height,payload) VALUES($1,'claim',$2,$3,$4,'prepared','message','transaction',1,'{}')",[randomUUID(),wallet,mint,bag]);await c.query('COMMIT');return true;}catch(e){await c.query('ROLLBACK');throw e;}finally{c.release();}};
 const results=await Promise.all(['one','two','three','four'].map(compete));assert.equal(results.filter(Boolean).length,1);assert.equal((await pool.query('SELECT count(*) FROM artemi_attempts')).rows[0].count,'1');console.log('PASS: four concurrent claimants produce one reservation and one attempt.');
 await assert.rejects(pool.query("INSERT INTO artemi_attempts(id,kind,wallet,mint,bag_id,status,message,transaction_base64,last_valid_height,payload) VALUES($1,'claim','other',$2,$3,'prepared','m','t',1,'{}')",[randomUUID(),mint,bag]),{code:'23505'});console.log('PASS: database rejects a second active attempt for the same bag.');
 const c=await pool.connect();try{await c.query('BEGIN');await c.query('SAVEPOINT process_attempt');await c.query("UPDATE artemi_bags SET status='claimed' WHERE id=$1",[bag]);await c.query('ROLLBACK TO SAVEPOINT process_attempt');await c.query('COMMIT');assert.equal((await c.query('SELECT status FROM artemi_bags WHERE id=$1',[bag])).rows[0].status,'reserved');console.log('PASS: interrupted finalization preserves the reserved state.');}finally{c.release();}
}finally{await pool.end();await admin.query(`DROP SCHEMA ${schema} CASCADE`);await admin.end();console.log('Isolated test schema removed; production data unchanged.');}
