import fs from 'node:fs'
import path from 'node:path'
import { PrototypeError, prototypesDir, type Prototype } from './store'

// Per-prototype JSON storage for window.hub.db: /data/prototypes/{id}/data.json,
// removed together with the prototype. Not versioned with the HTML.

export const MAX_DATA_BYTES = 50 * 1024 * 1024

export type StoredData = { rev: number; data: unknown }

export class DataConflictError extends Error {}

function dataFile(id: string): string {
  return path.join(prototypesDir(), id, 'data.json')
}

export function readData(p: Pick<Prototype, 'id'>): StoredData {
  try {
    const parsed = JSON.parse(fs.readFileSync(dataFile(p.id), 'utf8')) as StoredData
    return { rev: parsed.rev, data: parsed.data }
  } catch {
    return { rev: 0, data: {} }
  }
}

/** Replace the whole document. `ifRev` — optimistic lock: a different current rev throws DataConflictError. */
export function writeData(p: Pick<Prototype, 'id'>, data: unknown, ifRev?: number): number {
  const json = JSON.stringify(data)
  if (json === undefined) throw new PrototypeError('Данные должны быть JSON')
  if (Buffer.byteLength(json) > MAX_DATA_BYTES) throw new PrototypeError(`Данные больше ${MAX_DATA_BYTES / 1024 / 1024} МБ`)
  const current = readData(p).rev
  if (ifRev !== undefined && ifRev !== current) throw new DataConflictError()
  const rev = current + 1
  const file = dataFile(p.id)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  // Write + rename: a reader never sees half a file.
  const tmp = `${file}.tmp`
  fs.writeFileSync(tmp, `{"rev":${rev},"data":${json}}`, 'utf8')
  fs.renameSync(tmp, file)
  return rev
}

export function dataSize(p: Pick<Prototype, 'id'>): number | null {
  try {
    return fs.statSync(dataFile(p.id)).size
  } catch {
    return null
  }
}

export function clearData(p: Pick<Prototype, 'id'>): void {
  fs.rmSync(dataFile(p.id), { force: true })
}

/** Script that defines window.hub.db; injected before anything else in the page. */
export function dataScript(slug: string, token: string): string {
  const js = `(()=>{const url=new URL(${JSON.stringify(`/p/${slug}/db`)},location.href).href,token=${JSON.stringify(token)};
async function call(method,body,rev){const headers={Authorization:'Bearer '+token};
if(body!==undefined)headers['Content-Type']='application/json';if(rev!==undefined)headers['If-Match']='"'+rev+'"';
const res=await fetch(url,{method,headers,body:body===undefined?undefined:JSON.stringify(body),cache:'no-store'});
if(res.status===409){const e=new Error('hub.db: conflict');e.code='conflict';throw e}
if(!res.ok){let m=res.statusText;try{m=(await res.json()).error||m}catch{}throw new Error('hub.db: '+res.status+' '+m)}
return{res,rev:Number((res.headers.get('ETag')||'0').replace(/"/g,''))}}
async function read(){const r=await call('GET');return{data:await r.res.json(),rev:r.rev}}
const db={get:async()=>(await read()).data,set:async(data)=>{await call('PUT',data)},
update:async(fn)=>{for(let i=0;i<8;i++){const cur=await read();const out=await fn(cur.data);const next=out===undefined?cur.data:out;
try{await call('PUT',next,cur.rev);return next}catch(e){if(e.code!=='conflict')throw e}}throw new Error('hub.db: too many concurrent writes')}};
window.hub=Object.freeze({db:Object.freeze(db)})})();`
  return `<script>${js}</script>`
}

/** Put the script right after <head>, else after <html>/doctype — never before the doctype (quirks mode). */
export function injectDataScript(html: string, slug: string, token: string): string {
  const script = dataScript(slug, token)
  for (const re of [/<head(\s[^>]*)?>/i, /<html(\s[^>]*)?>/i, /<!doctype[^>]*>/i]) {
    const m = re.exec(html)
    if (m) return html.slice(0, m.index + m[0].length) + script + html.slice(m.index + m[0].length)
  }
  return script + html
}
