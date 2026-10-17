import { execFileSync } from 'node:child_process';
import { createDecipheriv, createHash, pbkdf2Sync } from 'node:crypto';
import { mkdir, writeFile, chmod, rename } from 'node:fs/promises';
import { homedir } from 'node:os';
import { resolve, dirname, join } from 'node:path';

if (process.platform !== 'darwin') throw new Error('此导入器目前只支持 macOS Chrome');
const output = resolve(process.argv[2] ?? '.local/credentials/chrome-cookies.json');
const profile = process.argv[3] ?? 'Default';
if (!/^(Default|Profile \d+)$/.test(profile)) throw new Error('Chrome profile 名称无效');
const database = join(homedir(), 'Library/Application Support/Google/Chrome', profile, 'Cookies');
// Read only the two explicitly supported sites. Never emit cookie values or key material.
const rows = JSON.parse(execFileSync('python3', ['-c', `
import sqlite3,json,base64,sys
from pathlib import Path
connection=sqlite3.connect(Path(sys.argv[1]).as_uri()+'?mode=ro',uri=True)
rows=connection.execute("SELECT host_key,name,path,expires_utc,is_secure,encrypted_value,value FROM cookies WHERE host_key IN ('.github.com','github.com','.bilibili.com','bilibili.com','www.bilibili.com','api.bilibili.com')").fetchall()
print(json.dumps([dict(domain=r[0],name=r[1],path=r[2],expires=r[3],secure=bool(r[4]),encrypted=base64.b64encode(r[5]).decode(),value=r[6]) for r in rows]))
`, database], { encoding:'utf8', maxBuffer:2*1024*1024 }));
const password = execFileSync('/usr/bin/security', ['find-generic-password','-w','-s','Chrome Safe Storage'], {encoding:'utf8',stdio:['ignore','pipe','pipe']}).replace(/\r?\n$/, '');
const key = pbkdf2Sync(password, 'saltysalt', 1003, 16, 'sha1');
const platforms = {github:[],bilibili:[]};
const names={github:new Set(['user_session','__Host-user_session_same_site','_gh_sess','logged_in','dotcom_user']),bilibili:new Set(['SESSDATA','bili_jct','DedeUserID','DedeUserID__ckMd5','buvid3','buvid4','buvid_fp','b_nut'])};
for (const row of rows) {
  const platform=row.domain.endsWith('github.com')?'github':'bilibili';
  if(!names[platform].has(row.name))continue;
  const expires = row.expires ? row.expires / 1_000_000 - 11644473600 : 0;
  if (expires && expires <= Date.now()/1000) continue;
  let value = row.value;
  if (!value && row.encrypted) {
    const encrypted=Buffer.from(row.encrypted,'base64');
    if (encrypted.subarray(0,3).toString() !== 'v10') throw new Error('不支持此Chrome Cookie加密版本');
    const decipher=createDecipheriv('aes-128-cbc',key,Buffer.alloc(16,32));
    let plain=Buffer.concat([decipher.update(encrypted.subarray(3)),decipher.final()]);
    const hash=createHash('sha256').update(row.domain).digest();
    if (plain.subarray(0,32).equals(hash)) plain=plain.subarray(32);
    value=plain.toString('utf8');
  }
  if (!value || /[\r\n\x00]/.test(value)) continue;
  platforms[row.domain.endsWith('github.com')?'github':'bilibili'].push({domain:row.domain,name:row.name,path:row.path,value,expires,secure:row.secure});
}
key.fill(0);
if (!platforms.github.some(x=>x.name==='user_session') || !platforms.bilibili.some(x=>x.name==='SESSDATA')) throw new Error('Chrome当前profile缺少GitHub或B站有效登录Cookie');
await mkdir(dirname(output),{recursive:true,mode:0o700});
const temporary=output+'.tmp';
await writeFile(temporary,JSON.stringify({version:1,importedAt:new Date().toISOString(),platforms}),{mode:0o600});
await chmod(temporary,0o600);
await rename(temporary,output);
console.log(JSON.stringify({saved:true,profile,counts:Object.fromEntries(Object.entries(platforms).map(([k,v])=>[k,v.length]))}));
