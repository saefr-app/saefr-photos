import {createHash, timingSafeEqual} from 'node:crypto';
import {readFileSync, statSync} from 'node:fs';
import {Failure, fields, HASH, UUID} from './protocol.mjs';

export class Authorizer {
  constructor(filename) { this.filename=filename; this.configuration(); }
  configuration() {
    try {
      if (statSync(this.filename).size>65536) throw new Error('large');
      const config=JSON.parse(readFileSync(this.filename,'utf8'));
      fields(config,['admin_token_sha256','principals']);
      if (!HASH.test(config.admin_token_sha256) || !Array.isArray(config.principals)) throw new Error('invalid');
      const seen=new Set([config.admin_token_sha256]);
      for (const principal of config.principals) {
        fields(principal,['token_sha256','scopes','permissions']);
        if (!HASH.test(principal.token_sha256) || seen.has(principal.token_sha256)
            || !Array.isArray(principal.scopes) || principal.scopes.some(id=>!UUID.test(id))
            || !Array.isArray(principal.permissions) || !principal.permissions.length
            || principal.permissions.some(role=>!['search','manage'].includes(role))) throw new Error('invalid');
        seen.add(principal.token_sha256);
      }
      return config;
    } catch { throw new Failure('INVALID_ACCESS_CONFIGURATION',503); }
  }
  authorize(request,scopeId,permission='search') {
    const match=/^Bearer ([A-Za-z0-9_-]{32,256})$/.exec(request.headers.authorization??'');
    if (!match) throw new Failure('UNAUTHORIZED',401);
    const actual=createHash('sha256').update(match[1]).digest();
    const config=this.configuration();
    const equal=value=>timingSafeEqual(actual,Buffer.from(value,'hex'));
    if (equal(config.admin_token_sha256)) return {admin:true};
    const principal=config.principals.find(item=>equal(item.token_sha256));
    if (!principal) throw new Failure('UNAUTHORIZED',401);
    if (permission==='admin' || !principal.scopes.includes(scopeId)
        || (!principal.permissions.includes(permission) && !principal.permissions.includes('manage')))
      throw new Failure('NOT_FOUND',404);
    return {admin:false};
  }
}
