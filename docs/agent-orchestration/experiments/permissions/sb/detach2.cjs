const {spawn}=require('child_process');
spawn('/bin/sleep',['30'],{detached:true,stdio:'ignore',env:{...process.env}}).unref();
