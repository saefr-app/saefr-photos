import {createHash, randomUUID} from 'node:crypto';
import {mkdir, open, link, unlink, lstat, readFile, readdir} from 'node:fs/promises';
import {join} from 'node:path';
import {digest, Failure, HASH, MAX_IMAGE} from './protocol.mjs';

export class Inputs {
  constructor(root) { this.root=root; }
  async init() { await mkdir(this.root,{recursive:true,mode:0o700}); }
  path(key) { if (!HASH.test(key)) throw new Failure('INVALID_INPUT_KEY'); return join(this.root,key+'.blob'); }
  async read(key,descriptor) {
    try {
      const path=this.path(key); const stat=await lstat(path);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size!==descriptor.byte_size || stat.size>MAX_IMAGE)
        throw new Error('invalid');
      const content=await readFile(path);
      if (createHash('sha256').update(content).digest('hex')!==descriptor.sha256) throw new Error('invalid');
      return content;
    } catch { throw new Failure('SOURCE_UNAVAILABLE',503); }
  }
  async accept(request,scopeId,assetId,generation) {
    const mediaType=(request.headers['content-type']??'').split(';')[0].trim().toLowerCase();
    if (!['image/jpeg','image/png','image/webp'].includes(mediaType)) throw new Failure('UNSUPPORTED_MEDIA',415);
    const declared=request.headers['content-length'];
    if (declared && (!/^[0-9]{1,10}$/.test(declared) || Number(declared)>MAX_IMAGE))
      throw new Failure('PAYLOAD_TOO_LARGE',413);
    const temporary=join(this.root,'.tmp-'+randomUUID());
    const file=await open(temporary,'wx',0o600);
    const hash=createHash('sha256'); let size=0,timedOut=false;
    const timer=setTimeout(()=>{timedOut=true;request.destroy();},15000); timer.unref();
    let closed=false;
    try {
      for await (const chunk of request.iterator({destroyOnReturn:false})) {
        size+=chunk.length;
        if (size>MAX_IMAGE) throw new Failure('PAYLOAD_TOO_LARGE',413);
        hash.update(chunk); await file.writeFile(chunk);
      }
      if (!size || (declared && Number(declared)!==size)) throw new Failure('INVALID_REQUEST');
      await file.sync(); await file.close(); closed=true;
      const image={sha256:hash.digest('hex'),byte_size:size,media_type:mediaType};
      const key=digest({scopeId,assetId,generation,sha256:image.sha256});
      try { await link(temporary,this.path(key)); }
      catch (error) { if (error.code!=='EEXIST') throw error; await this.read(key,image); }
      return {key,image};
    } catch (error) {
      if (error instanceof Failure) throw error;
      throw new Failure(timedOut?'INPUT_TIMEOUT':'INVALID_REQUEST',timedOut?408:422);
    } finally {
      clearTimeout(timer); if (!closed) await file.close();
      await unlink(temporary).catch(error=>{if(error.code!=='ENOENT')throw new Failure('CLEANUP_PENDING',503);});
    }
  }
  async removeUnused(store,keys) {
    for (const key of keys) {
      if (store.inputReferenced(key)) continue;
      try {
        const path=this.path(key); const stat=await lstat(path);
        if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('invalid');
        await unlink(path);
      } catch (error) { if(error.code!=='ENOENT')throw new Failure('CLEANUP_PENDING',503); }
    }
  }
  async reconcile(store,minAgeMs=60000) {
    for (const name of await readdir(this.root)) {
      const match=/^([0-9a-f]{64})\.blob$/.exec(name);
      const temporary=/^\.tmp-[0-9a-f-]{36}$/.test(name);
      if (!match && !temporary) continue;
      const path=join(this.root,name); const stat=await lstat(path);
      if (!stat.isFile() || stat.isSymbolicLink() || Date.now()-stat.mtimeMs<minAgeMs) continue;
      if (temporary || !store.inputReferenced(match[1])) await unlink(path);
    }
  }
}
