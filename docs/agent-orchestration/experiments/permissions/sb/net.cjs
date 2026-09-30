// node net.js local|ext|dns | port N | connect N [host] | bindany N | unix P | uconnect P | serve N [host]|P (30s)
const net=require('net'),dns=require('dns');const [m,a]=process.argv.slice(2);
const fail=e=>{console.error(e.code||e.message);process.exit(1)};
const t=setTimeout(()=>fail({code:'TIMEOUT'}),m==='serve'?30000:4000);
const pair=(...l)=>{const s=net.createServer(c=>c.end('hi')).listen(...l,()=>{const ad=s.address();net.connect(typeof ad==='string'?ad:{port:ad.port,host:'127.0.0.1'}).on('data',d=>{console.log('got',d+'');process.exit(0)}).on('error',fail)}).on('error',fail)};
const conn=o=>net.connect(o).on('data',d=>{console.log('got',d+'');process.exit(0)}).on('error',fail);
if(m==='local')pair(0,'127.0.0.1');
if(m==='port')pair(+a,'127.0.0.1');
if(m==='bindany')pair(+a,'0.0.0.0');
if(m==='unix')pair(a);
if(m==='connect')conn({port:+a,host:process.argv[4]||'127.0.0.1'});
if(m==='uconnect')conn(a);
if(m==='serve'){net.createServer(c=>c.end('hi')).listen(/^\d+$/.test(a)?{port:+a,host:process.argv[4]||'127.0.0.1'}:a,()=>console.log('listening')).on('error',fail);setTimeout(()=>process.exit(0),30000)}
if(m==='ext')net.connect(443,'1.1.1.1',()=>process.exit(0)).on('error',fail);
if(m==='dns')dns.lookup('example.com',(e,r)=>e?fail(e):(console.log(r),process.exit(0)));
