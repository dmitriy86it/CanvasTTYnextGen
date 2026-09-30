// node detach.cjs PROBE FIX RUN OUTFILE: detached (new pgid, parent exits) probe run after 2s
const {spawn}=require('child_process');const [p,fix,run,out]=process.argv.slice(2);
spawn('/bin/sh',['-c','sleep 2; /bin/sh "$0" "$1" "$2" in-det > "$3" 2>&1; echo done >> "$3"; : CTTYEXP-det',p,fix,run,out],{detached:true,stdio:'ignore'}).unref();
