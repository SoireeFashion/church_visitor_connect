// Offline synthetic tests + isolated PostgreSQL/WASM RLS tests; no Supabase calls.
// node tests/trial-accounts.mjs <DOM/TS node_modules> <PGlite node_modules>
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {pathToFileURL} from 'node:url';
import vm from 'node:vm';
import {test} from 'node:test';
import {execFileSync} from 'node:child_process';
const [deps,pgdeps]=process.argv.slice(2);
const {default:ts}=await import(pathToFileURL(`${deps}/typescript/lib/typescript.js`));
const {parseHTML}=await import(pathToFileURL(`${deps}/linkedom/esm/index.js`));
const {PGlite}=await import(pathToFileURL(`${pgdeps}/@electric-sql/pglite/dist/index.js`));
const read=p=>readFileSync(p,'utf8');
const html=read('index.html'),sql=read('supabase/migrations/20261101205119_platform_trial_accounts.sql');
const source=read('supabase/functions/create-church/index.ts');
const uuid=n=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const platform=uuid(1),staff=uuid(2),outsider=uuid(3),legacy=uuid(10),visitor=uuid(20);
const cutoff='2027-01-01T06:00:00Z';
const compile=s=>ts.transpileModule(s.replace(/^import .*$/mg,''),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText;
async function createChurch(body,{authorized=true,rpcError=false,inviteError=false}={}){
  const calls=[],church={id:uuid(11),name:'Synthetic Trial',slug:'synthetic-trial'};
  const admin={from:table=>({select(){return this;},eq(){return this;},maybeSingle:async()=>({data:null}),
    insert(values){calls.push(['insert',table,values]);return table==='churches'?{select(){return this;},single:async()=>({data:church})}:Promise.resolve({error:null});},
    delete(){calls.push(['delete',table]);return this;}}),
    auth:{admin:{inviteUserByEmail:async()=>{calls.push(['invite']);return inviteError?{error:{message:'synthetic delivery failure'}}:{data:{user:{id:uuid(12)}}};},deleteUser:async()=>{calls.push(['deleteUser']);}}}};
  const ctx={userClaims:{id:platform},supabase:{rpc:async(name,args)=>{calls.push(['rpc',name,args]);return name==='is_platform_admin'?{data:authorized}:rpcError?{error:{message:'trial denied'}}:{data:[church]};}}};
  const context={exports:{},Response,console:{error(){}},corsHeaders:{},createClient:()=>admin,
    createSupabaseContext:async()=>({data:ctx}),Deno:{env:{get:key=>({SUPABASE_URL:'http://localhost',SUPABASE_SECRET_KEYS:'{"default":"synthetic-only"}'})[key]}}};
  vm.runInNewContext(compile(source),context);
  const response=await context.exports.default.fetch(new Request('http://localhost',{method:'POST',body:JSON.stringify(body)}));
  return {status:response.status,body:await response.json(),calls};
}
const formBody={churchName:'Synthetic Trial',slug:'synthetic-trial',websiteUrl:'https://example.test',adminFirstName:'Test',adminLastName:'Admin',adminEmail:'test@example.test',isTrial:true};
await test('trial creation requires verified Platform Administrator before any writes or email',async()=>{const r=await createChurch(formBody,{authorized:false});assert.equal(r.status,403);assert.equal(r.calls.length,1);});
await test('trial creation delegates fixed-date atomic insert to caller-scoped RPC',async()=>{
  const r=await createChurch(formBody);assert.equal(r.status,200);
  assert.deepEqual(JSON.parse(JSON.stringify(r.calls.find(c=>c[1]==='platform_create_trial_church'))),['rpc','platform_create_trial_church',{p_name:formBody.churchName,p_website_url:formBody.websiteUrl,p_slug:formBody.slug}]);
  assert.ok(!r.calls.some(c=>c[0]==='insert'&&c[1]==='churches'));assert.ok(r.calls.some(c=>c[0]==='insert'&&c[1]==='church_users'));
});
await test('failed trial RPC does not send an invitation or create memberships',async()=>{const r=await createChurch(formBody,{rpcError:true});assert.equal(r.status,500);assert.ok(!r.calls.some(c=>['invite','insert'].includes(c[0])));});
await test('nontrial creation preserves existing insert fields and invite flow',async()=>{const r=await createChurch({...formBody,isTrial:false});assert.equal(r.status,200);const insert=r.calls.find(c=>c[0]==='insert'&&c[1]==='churches');assert.deepEqual(Object.keys(insert[2]),['name','website_url','slug']);assert.ok(!r.calls.some(c=>c[1]==='platform_create_trial_church'));});
await test('nonboolean trial option is rejected',async()=>assert.equal((await createChurch({...formBody,isTrial:'true'})).status,400));
await test('Create Church checkbox sends only the selected trial boolean',async()=>{
  const {document}=parseHTML(html);const calls=[];
  document.getElementById('platformChurchForm').reset=()=>{};
  for(const [id,value] of Object.entries({platformChurchName:'Synthetic',platformChurchWebsite:'https://example.test',platformChurchSlug:'synthetic',platformAdminFirstName:'Test',platformAdminLastName:'Admin',platformAdminInviteEmail:'test@example.test'}))document.getElementById(id).value=value;
  const c={document,console,supabaseClient:{functions:{invoke:async(name,args)=>{calls.push([name,args.body]);return {data:{success:true,church:{name:'Synthetic'},administrator:{email:'test@example.test'}}};}}},updatePlatformRegistrationPreview(){},loadPlatformChurches:async()=>{}};
  vm.createContext(c);vm.runInContext(html.slice(html.indexOf('async function createPlatformChurch('),html.indexOf('\ndocument\n  .getElementById("platformChurchForm")')),c);
  for(const checked of [true,false]){document.getElementById('platformTrialAccount').checked=checked;await c.createPlatformChurch({preventDefault(){}});assert.equal(calls.at(-1)[1].isTrial,checked);assert.equal(calls.at(-1)[0],'create-church');}
});

// Minimal synthetic representation of the inspected production access paths.
// This executes the actual proposed migration in an in-memory SQL database.
const db=new PGlite();
const exec=q=>db.exec(q), scalar=async q=>Object.values((await db.query(q)).rows[0])[0];
await exec(`CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role BYPASSRLS;
CREATE SCHEMA auth; CREATE SCHEMA storage;
CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$SELECT nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
CREATE TABLE public.churches(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),name text,slug text UNIQUE,website_url text);
CREATE TABLE public.platform_admins(user_id uuid);
CREATE TABLE public.church_users(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),church_id uuid,user_id uuid,role text,invitation_status text);
CREATE TABLE public.visitors(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),church_id uuid,first_name text,photo_url text);
CREATE TABLE storage.objects(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),bucket_id text,name text);
CREATE FUNCTION public.is_platform_admin() RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path='' AS $$SELECT EXISTS(SELECT 1 FROM public.platform_admins WHERE user_id=auth.uid())$$;
CREATE FUNCTION public.church_exists(target_church_id uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path='' AS $$SELECT EXISTS(SELECT 1 FROM public.churches WHERE id=target_church_id)$$;
CREATE FUNCTION public.has_church_role(target_church_id uuid,allowed_roles text[]) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path='' AS $$SELECT EXISTS(SELECT 1 FROM public.church_users WHERE church_id=target_church_id AND user_id=auth.uid() AND role=ANY(allowed_roles))$$;
CREATE FUNCTION public.is_church_admin(target_church_id uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path='' AS $$SELECT public.has_church_role(target_church_id,ARRAY['admin'])$$;
ALTER TABLE public.churches ENABLE ROW LEVEL SECURITY;ALTER TABLE public.church_users ENABLE ROW LEVEL SECURITY;ALTER TABLE public.visitors ENABLE ROW LEVEL SECURITY;ALTER TABLE storage.objects ENABLE ROW LEVEL SECURITY;
CREATE POLICY baseline_church ON public.churches FOR SELECT TO authenticated USING(public.is_church_admin(id));
CREATE POLICY baseline_staff ON public.church_users FOR ALL TO authenticated USING(public.is_church_admin(church_id)) WITH CHECK(public.is_church_admin(church_id));
CREATE POLICY own_membership ON public.church_users FOR SELECT TO authenticated USING(user_id=auth.uid());
CREATE POLICY visitor_read ON public.visitors FOR SELECT TO authenticated USING(public.has_church_role(church_id,ARRAY['admin','outreach']));
CREATE POLICY visitor_write ON public.visitors FOR UPDATE TO authenticated USING(public.has_church_role(church_id,ARRAY['admin','outreach'])) WITH CHECK(public.has_church_role(church_id,ARRAY['admin','outreach']));
CREATE POLICY visitor_delete ON public.visitors FOR DELETE TO authenticated USING(public.is_church_admin(church_id));
CREATE POLICY registration ON public.visitors FOR INSERT TO anon,authenticated WITH CHECK(public.church_exists(church_id));
CREATE POLICY photos ON storage.objects FOR SELECT TO authenticated USING(bucket_id='visitor-photos' AND public.has_church_role(split_part(name,'/',1)::uuid,ARRAY['admin','outreach','greeter']));
GRANT USAGE ON SCHEMA public,auth,storage TO anon,authenticated,service_role;
GRANT ALL ON public.churches,public.church_users,public.visitors,storage.objects TO anon,authenticated;
INSERT INTO public.platform_admins VALUES('${platform}');
INSERT INTO public.churches(id,name,slug) VALUES('${legacy}','Existing Synthetic Church','existing');
INSERT INTO public.church_users(church_id,user_id,role,invitation_status) VALUES('${legacy}','${staff}','admin','active');
INSERT INTO public.visitors(id,church_id,first_name) VALUES('${visitor}','${legacy}','Preserve Me');`);
for(const table of ['churches','church_users','visitors'])await exec(`CREATE POLICY platform_access ON public.${table} FOR ALL TO authenticated USING(public.is_platform_admin()) WITH CHECK(public.is_platform_admin())`);
await test('actual migration applies to synthetic SQL schema without changing existing rows',async()=>{
  await exec(sql);assert.equal(await scalar(`SELECT count(*) FROM public.visitors WHERE id='${visitor}' AND first_name='Preserve Me'`),1);
  assert.equal(await scalar(`SELECT trial_ends_at IS NULL FROM public.churches WHERE id='${legacy}'`),true);
});
// Test-only clock substitution AFTER compiling/applying the unmodified migration.
// Production definitions remain clock-independent and use database statement time.
for(const signature of ['public.platform_create_trial_church(text,text,text)','public.protect_church_trial()','public.trial_access_allowed(uuid)','public.my_church_access(uuid)']){
  const def=await scalar(`SELECT pg_get_functiondef('${signature}'::regprocedure)`);
  await exec(def.replaceAll('statement_timestamp()',"current_setting('trial_test.now')::timestamptz").replaceAll('now()',"current_setting('trial_test.now')::timestamptz"));
}
const at=async time=>exec(`SELECT set_config('trial_test.now','${time}',false)`);
const as=async user=>exec(`RESET ROLE;SET ROLE authenticated;SELECT set_config('request.jwt.claim.sub','${user}',false)`);
await at('2026-11-01T12:00:00Z');
await test('ordinary church admin cannot create trial through direct SQL RPC',async()=>{await as(staff);await assert.rejects(exec(`SELECT * FROM public.platform_create_trial_church('Denied',null,'denied')`),/Platform Administrator required/);});
let trial;
await test('Platform Administrator creates trial with fixed expiry and stable registration slug',async()=>{
  await as(platform);trial=await scalar(`SELECT id FROM public.platform_create_trial_church('Trial Church','https://example.test','trial-church')`);
  assert.equal(await scalar(`SELECT trial_ends_at=timestamptz '${cutoff}' AND slug='trial-church' FROM public.churches WHERE id='${trial}'`),true);
});
await test('trial creation cannot reuse an existing church registration link',async()=>{
  await assert.rejects(exec(`SELECT * FROM public.platform_create_trial_church('Duplicate',null,'existing')`),/already in use/);
  assert.equal(await scalar(`SELECT count(*) FROM public.churches WHERE slug='existing'`),1);
});
await exec(`RESET ROLE;INSERT INTO public.church_users(church_id,user_id,role,invitation_status) VALUES('${trial}','${staff}','admin','active');INSERT INTO public.visitors(church_id,first_name) VALUES('${trial}','Trial Visitor');INSERT INTO storage.objects(bucket_id,name) VALUES('visitor-photos','${trial}/photo.jpg')`);
await test('trial admin retains protected visitor access until final instant of December 31 Chicago',async()=>{await as(staff);await at('2027-01-01T05:59:59.999Z');assert.equal(await scalar(`SELECT count(*) FROM public.visitors WHERE church_id='${trial}'`),1);});
await test('direct visitor SELECT and UPDATE are blocked at exact January 1 cutoff',async()=>{
  await at(cutoff);assert.equal(await scalar(`SELECT count(*) FROM public.visitors WHERE church_id='${trial}'`),0);
  assert.equal((await db.query(`UPDATE public.visitors SET first_name='Forbidden' WHERE church_id='${trial}' RETURNING id`)).rows.length,0);
  assert.equal(await scalar(`SELECT access_allowed FROM public.my_church_access('${trial}')`),false);
});
await test('direct staff administrative writes and removal RPC are blocked after expiration',async()=>{
  await assert.rejects(exec(`INSERT INTO public.church_users(church_id,user_id,role) VALUES('${trial}','${outsider}','admin')`),/row-level security/);
  await assert.rejects(exec(`SELECT public.remove_church_staff('${trial}','${outsider}')`),/Trial Account expired/);
});
await test('own membership remains readable for login; other church data stays isolated',async()=>{
  assert.equal(await scalar(`SELECT count(*) FROM public.church_users WHERE church_id='${trial}' AND user_id='${staff}'`),1);
  await as(outsider);assert.equal(await scalar(`SELECT count(*) FROM public.visitors`),0);assert.equal((await db.query(`SELECT * FROM public.my_church_access('${trial}')`)).rows.length,0);
});
await test('nontrial church retains existing visitor access after the trial cutoff',async()=>{await as(staff);assert.equal(await scalar(`SELECT count(*) FROM public.visitors WHERE church_id='${legacy}'`),1);});
await test('Platform Administrator can manage expired church and read its visitors',async()=>{await as(platform);assert.equal(await scalar(`SELECT count(*) FROM public.visitors WHERE church_id='${trial}'`),1);assert.equal(await scalar(`SELECT count(*) FROM public.churches WHERE id='${trial}'`),1);});
await test('public registration still inserts a synthetic visitor into an expired church',async()=>{await exec(`RESET ROLE;SET ROLE anon;SELECT set_config('request.jwt.claim.sub','',false);INSERT INTO public.visitors(church_id,first_name) VALUES('${trial}','Public Registration')`);});
await test('trial photo direct access and long-lived signing policy are closed, even before cutoff',async()=>{
  await as(staff);await at('2026-12-31T12:00:00Z');assert.equal(await scalar(`SELECT count(*) FROM storage.objects`),0);
  await at(cutoff);assert.equal(await scalar(`SELECT count(*) FROM storage.objects`),0);
});
await test('trial designation and TRUNCATE cannot be changed directly by browser roles',async()=>{
  assert.equal((await db.query(`UPDATE public.churches SET trial_ends_at=NULL WHERE id='${trial}' RETURNING id`)).rows.length,0);
  await exec('RESET ROLE');
  await assert.rejects(exec(`UPDATE public.churches SET trial_ends_at=NULL WHERE id='${trial}'`),/Platform Administrator required/);
  await as(staff);
  for(const role of ['anon','authenticated'])assert.equal(await scalar(`SELECT has_table_privilege('${role}','public.visitors','TRUNCATE')`),false);
});
await test('no new trial can be created after expiry; visitor data remains unchanged',async()=>{
  await as(platform);await assert.rejects(exec(`SELECT * FROM public.platform_create_trial_church('Late',null,'late')`),/Trial creation has ended/);
  await exec('RESET ROLE');assert.equal(await scalar(`SELECT first_name FROM public.visitors WHERE id='${visitor}'`),'Preserve Me');assert.equal(await scalar(`SELECT count(*) FROM public.visitors WHERE first_name='Forbidden'`),0);
});
await db.close();

function accessUI({allowed=true,platform=false,error=false,active=true}={}){
  const {document}=parseHTML(html);const id=uuid(11);let clears=0;
  const c={document,Set,URL,Blob,CHURCH_ID:id,DASHBOARD_EPOCH:0,CURRENT_STAFF_ROLE:'admin',CURRENT_CHURCH:{trial_active:active},PLATFORM_DASHBOARD_CHURCH_ID:platform?id:null,
    supabaseClient:{rpc:async()=>({data:[{church_id:id,role:'admin',access_allowed:allowed,trial_active:active}],error:error?{}:null})},
    clearPlatformDashboard:()=>{clears++;c.DASHBOARD_EPOCH++;}};
  vm.createContext(c);vm.runInContext(html.slice(html.indexOf('const CHURCH_PHOTO_URLS ='),html.indexOf('function showGetVisitorConnect(')),c);
  return {c,document,clears:()=>clears};
}
await test('active trial UI displays Trial Account without a countdown',async()=>{const u=accessUI();assert.equal(await u.c.guardChurchTrial('admin'),true);const badge=u.document.getElementById('trialAccountBadge');assert.equal(badge.textContent,'Trial Account');assert.equal(badge.classList.contains('hidden'),false);});
await test('expired trial UI clears cached visitors and blocks dashboard',async()=>{const u=accessUI({allowed:false,active:false});assert.equal(await u.c.guardChurchTrial('admin'),false);assert.equal(u.clears(),1);assert.match(u.document.getElementById('trialExpiredMessage').textContent,/expired/);assert.equal(u.document.getElementById('adminView').classList.contains('hidden'),true);});
await test('access verification errors fail closed',async()=>{const u=accessUI({error:true});assert.equal(await u.c.guardChurchTrial('admin'),false);assert.equal(u.clears(),1);});
await test('verified Platform dashboard remains accessible after expiration',async()=>{const u=accessUI({platform:true,active:false,allowed:false});assert.equal(await u.c.guardChurchTrial('admin'),true);assert.equal(u.clears(),0);});

await test('frontend scripts parse; initial signup checkout is byte-for-byte preserved',()=>{
  for(const match of html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g))if(match[1].trim())new vm.Script(match[1]);
  assert.doesNotMatch(html,/continued-subscription|Continued Subscription|subscriptionRequiredView|set_trial/);
  assert.doesNotMatch(sql,/stripe_|subscriptions|visitor_connect_trial_private|lock_trial_billing/i);
  const baseline=execFileSync('git',['show','HEAD:index.html'],{encoding:'utf8'});
  const checkout=text=>text.slice(text.indexOf('document.getElementById("getVisitorConnectForm").addEventListener'),text.indexOf('document.getElementById("globalStaffLoginBtn").addEventListener'));
  assert.equal(checkout(html),checkout(baseline));
});
