// Cloudflare Pages Functions（号外でーす！）
//   POST /api/play   … 1ゲームを最後まで遊ぶごとに1回。今日の集計に足す
//   POST /api/post   … 結果画面の「掲示板に貼る」。1端末につき1日1枚（貼り直すと同じ番号のまま差し替え）
//   GET  /api/board  … 今日の駅前の掲示板（12枚で1面。?page= で前の面、なければ最新の面）と、本日の様子
//   GET  /api/photo  … 掲示板の号外の写真（?no=&v=）。写真は一覧に含めず、ここから別に取る
// 必要なもの：D1 のバインディング名 DB（表は schema.sql）
// 掲示板は「今日」の分だけ。号外が貼られるたびに、前日以前の行を消す（定期実行はいらない）
const J=(o,s=200)=>new Response(JSON.stringify(o),{status:s,headers:{'content-type':'application/json','cache-control':'no-store'}});
const day=()=>new Date(Date.now()+324e5).toISOString().slice(0,10).replace(/-/g,''); // 日本時間の日付 YYYYMMDD
const PER=12;                  // 掲示板1面の枚数
const PHOTO_MAX=40000;         // 写真の上限（バイト）。超えたら写真なしで貼る
const ENDS=['time','sold','stop'],KINDS=['pass','staff','kaze','miss','oshi'];
// 名前のチェック（2番地と同じ）
const NG=['しね','死ね','ころす','殺す','ばか','あほ','ちんこ','ちんぽ','まんこ','おっぱい','うんこ','くそ','自殺','きちがい','せっくす','ふぁっく','れいぷ','fuck','shit','sex','nazi','porn','rape','nigger'];
const norm=s=>s.normalize('NFKC').toLowerCase().replace(/[\s_\-.*・ー〜~]+/g,'').replace(/[ァ-ヶ]/g,c=>String.fromCharCode(c.charCodeAt(0)-96));
const cleanName=s=>String(s||'').normalize('NFKC').replace(/[^\p{L}\p{N}ー・_\-☆★♪ ]/gu,'').replace(/\s+/g,' ').trim().slice(0,10);
const badName=s=>NG.some(w=>norm(s).includes(w))||/https?|www|\.com/i.test(s);
const enc=new TextEncoder(),hex=b=>[...new Uint8Array(b)].map(x=>x.toString(16).padStart(2,'0')).join('');
const hashId=async id=>/^[0-9a-f]{32}$/.test(id||'')?hex(await crypto.subtle.digest('SHA-256',enc.encode('gg:'+id))).slice(0,32):null; // 端末のIDはそのまま保存しない
const num=(v,max=999)=>Math.max(0,Math.min(max,parseInt(v,10)||0));

// 季節号外（ゲーム側と同じ日付）。掲示板に貼る号外の季節は、送られてきた値ではなくサーバーの日付で決める
function seasonOf(d){
 const m=+d.slice(4,6),x=+d.slice(6,8);
 if(m===10&&x===31)return'halloween';
 if(m===12&&(x===24||x===25))return'xmas';
 if(m===12&&x===31)return'omisoka';
 if(m===1&&x===1)return'ganjitsu';
 if(m===1&&(x===2||x===3))return'shogatsu';
 if(m===12&&x>=14&&x<=30)return'ski';
 if(m===8&&x>=4&&x<=17)return'summer';
 if(m===3&&x>=3&&x<=16)return'sotsugyo';
 if(m===4&&x>=1&&x<=14)return'hanami';
 return'';
}
// 見出し・称号・二つ名はサーバーで組み立て直す（好きな文字を掲示板に載せられないように）。決め方はゲーム側と同じ
function paperOf(s){
 let head,sub2,kind='pass';
 if(s.end==='sold'){head='完売御礼';sub2='時間内に完売'}
 else if(s.end==='stop'){head='配布中止';sub2='駅員が制止';kind='staff'}
 else if(s.chuui>=2){head=`駅員が注意${s.chuui}回`;sub2='点字ブロックに号外';kind='staff'}
 else if(s.kaze>=3){head=`突風で${s.kaze}部`;sub2='号外、空へ舞う';kind='kaze'}
 else if(s.miss>=12){head=`空振り${s.miss}回`;sub2='それでも腕は伸びる';kind='miss'}
 else if(s.oshi>=8){head=`押しつけ${s.oshi}回`;sub2='駅前に緊張走る';kind='oshi'}
 else if(s.delivered>=30&&s.perf>=s.delivered*0.6){head=`パシッと${s.perf}部`;sub2='駅前に快音響く'}
 else{head=`本日${s.delivered}部`;sub2='駅前に号外舞う'}
 const n=s.delivered,rank=s.end==='stop'?'出入り禁止':n<40?'見習い配り':n<65?'駅前の顔':n<90?'号外職人':'伝説の号外屋';
 const nick=s.returned>=2?'待てる人':s.phone>=4?'画面割り込みの達人':s.hurry>=3?'駅前の韋駄天':s.kizukai>=3?'気づかいの人':s.combo>=25?'流れを読む人':s.kaze>=3?'風に好かれた人':(s.chuui>=2&&s.end!=='stop')?'駅員の顔なじみ':'';
 return {head,sub2,kind,rank,nick};
}
function statsOf(b){
 const s={end:ENDS.includes(b&&b.end)?b.end:'time'};
 for(const k of ['delivered','perf','oshi','miss','chuui','kaze','combo','returned','phone','hurry','kizukai'])s[k]=num(b&&b[k],k==='delivered'||k==='perf'?100:999);
 if(s.perf>s.delivered)s.perf=s.delivered;
 return s;
}
// 写真：data:image/jpeg;base64,… を受け取り、JPEG で上限以内なら保存する
function photoOf(src){
 const m=/^data:image\/jpeg;base64,([A-Za-z0-9+/=]+)$/.exec(String(src||''));if(!m||m[1].length>PHOTO_MAX*1.4)return null;
 try{const bin=atob(m[1]),u=new Uint8Array(bin.length);for(let i=0;i<bin.length;i++)u[i]=bin.charCodeAt(i);
  return u.length<=PHOTO_MAX&&u[0]===0xFF&&u[1]===0xD8?u.buffer:null}catch(e){return null}   // D1 の BLOB には ArrayBuffer で渡す
}

export async function onRequest(ctx){
 const {request:req,env,params}=ctx,path=[].concat(params.path||[]).join('/');
 if(!env.DB)return J({error:'no db'},500);
 if(path==='play'&&req.method==='POST')return play(ctx,env,req);
 if(path==='post'&&req.method==='POST')return post(ctx,env,req);
 if(path==='board'&&req.method==='GET')return board(env,req);
 if(path==='photo'&&req.method==='GET')return photo(env,req);
 return J({error:'not found'},404);
}

async function play(ctx,env,req){
 let b;try{b=await req.json()}catch(e){return J({error:'bad json'},400)}
 const s=statsOf(b),d=day();
 // 間引き（2番地と同じ）：今日のプレイ数が増えたら 10回・100回に1回だけ書き込み、その回数ぶん足す
 const row=await env.DB.prepare('SELECT plays FROM days WHERE d=?').bind(d).first();
 const total=row?row.plays:0,S=+env.SAMPLE||(total<20000?1:total<200000?10:100);
 if(Math.random()<1/S)ctx.waitUntil(env.DB.prepare(`INSERT INTO days(d,plays,sold,stop,delivered,perfect) VALUES(?,?,?,?,?,?)
   ON CONFLICT(d) DO UPDATE SET plays=plays+excluded.plays,sold=sold+excluded.sold,stop=stop+excluded.stop,delivered=delivered+excluded.delivered,perfect=perfect+excluded.perfect`)
   .bind(d,S,s.end==='sold'?S:0,s.end==='stop'?S:0,s.delivered*S,s.perf*S).run());
 return J({ok:true});
}

async function post(ctx,env,req){
 let b;try{b=await req.json()}catch(e){return J({error:'bad json'},400)}
 const h=await hashId(b&&b.id);if(!h)return J({error:'no id'},400);
 const d=day(),s=statsOf(b),p=paperOf(s),season=seasonOf(d);
 const raw=cleanName(b&&b.name);
 if(!raw||badName(raw))return J({error:'name'},400);   // 掲示板はニックネームが必須。使えない名前ははじく
 const name=raw;
 const kind=KINDS.includes(b&&b.kind)?b.kind:p.kind,ph=photoOf(b&&b.photo),t=Date.now();
 // 前日以前の号外を貼り替える（掲示板は今日の分だけ）
 ctx.waitUntil(env.DB.batch([env.DB.prepare('DELETE FROM board WHERE d<?').bind(d),env.DB.prepare('DELETE FROM boardn WHERE d<?').bind(d)]));
 try{
  const ex=await env.DB.prepare('SELECT no FROM board WHERE d=? AND h=?').bind(d,h).first();
  if(ex){
   await env.DB.prepare('UPDATE board SET name=?,t=?,head=?,sub2=?,delivered=?,rank=?,nick=?,kind=?,season=?,photo=? WHERE d=? AND h=?')
    .bind(name,t,p.head,p.sub2,s.delivered,p.rank,p.nick,kind,season,ph,d,h).run();
   return J({no:ex.no,replaced:true});
  }
  const n=await env.DB.prepare('INSERT INTO boardn(d,n) VALUES(?,1) ON CONFLICT(d) DO UPDATE SET n=n+1 RETURNING n').bind(d).first();
  await env.DB.prepare('INSERT OR IGNORE INTO board(d,no,h,name,t,head,sub2,delivered,rank,nick,kind,season,photo) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)')
   .bind(d,n.n,h,name,t,p.head,p.sub2,s.delivered,p.rank,p.nick,kind,season,ph).run();
  return J({no:n.n,new:true});
 }catch(e){return J({error:'failed'},500)}
}

async function board(env,req){
 const d=day(),u=new URL(req.url),h=await hashId(u.searchParams.get('id')),pq=parseInt(u.searchParams.get('page'),10)||0;
 const [cnt,me]=await Promise.all([
  env.DB.prepare('SELECT n FROM boardn WHERE d=?').bind(d).first(),
  h?env.DB.prepare('SELECT no FROM board WHERE d=? AND h=?').bind(d,h).first():null]);
 const n=cnt?cnt.n:0,pages=Math.max(1,Math.ceil(n/PER)),page=pq>=1&&pq<=pages?pq:pages; // 1面＝No.1〜12
 const rows=await env.DB.prepare('SELECT no,name,t,head,sub2,delivered,rank,nick,kind,season,photo IS NOT NULL AS ph FROM board WHERE d=? AND no>? AND no<=? ORDER BY no DESC')
  .bind(d,(page-1)*PER,page*PER).all();
 // 本日の様子：失敗しても掲示板は返す
 let stat=null;try{const dy=await env.DB.prepare('SELECT plays,sold,stop,delivered FROM days WHERE d=?').bind(d).first();
  stat=dy?{plays:dy.plays,sold:dy.sold,stop:dy.stop,delivered:dy.delivered}:{plays:0,sold:0,stop:0,delivered:0}}catch(e){}
 return J({d,n,page,pages,rows:rows.results||[],mine:me?me.no:null,stat,season:seasonOf(d)});
}

async function photo(env,req){
 const u=new URL(req.url),no=parseInt(u.searchParams.get('no'),10);
 if(!(no>0))return new Response('',{status:404});
 const r=await env.DB.prepare('SELECT photo FROM board WHERE d=? AND no=?').bind(day(),no).first();
 if(!r||!r.photo)return new Response('',{status:404});
 // ?v= に貼った時刻を付けて呼ぶので、貼り直したら別のURLになる。同じURLは長く使い回してよい
 return new Response(new Uint8Array(r.photo),{headers:   // D1 は BLOB を数値の配列で返すことがあるので、バイト列に戻す
  {'content-type':'image/jpeg','cache-control':'public, max-age=86400, immutable'}});
}
