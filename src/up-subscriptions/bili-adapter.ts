import crypto from 'node:crypto';
import { utils } from '@renmu/bili-api';
import { BiliResponseFormatError, BiliRiskOrLoginError } from '../bili.js';
import { biliWebCookieValues, type BiliUser, type UserStore } from '../users.js';
import { isRecord } from '../shared/api/value.js';
import type { UpDiscoveryPage, UpIdentity, UpSubmission } from '../shared/up-subscriptions.js';
import { decodeUpCard, decodeUpFollowings, decodeUpSearch, decodeUpSubmissions } from './bili-decoders.js';

export interface UpBiliPort {
  followings(userId: string, page: number, query: string): Promise<UpDiscoveryPage>;
  search(userId: string, query: string, page: number): Promise<UpDiscoveryPage>;
  profile(userId: string, uid: number): Promise<UpIdentity>;
  submissions(userId: string, uid: number, page: number): Promise<{items: UpSubmission[]; total: number; hasMore: boolean}>;
}
const mixin = [46,47,18,2,53,8,23,32,15,50,10,31,58,3,45,35,27,43,5,49,33,9,42,19,29,28,14,39,12,38,41,13,37,48,7,16,24,55,40,61,26,17,0,1,60,51,30,4,22,25,54,21,56,59,6,63,57,62,11,36,20,34,44,52];
export function signUpWbi(parameters: Record<string,string|number>, key: string, seconds: number) {
  const values = {...parameters, wts: seconds};
  const query = Object.entries(values).sort(([a],[b]) => a<b?-1:a>b?1:0).map(([name,value]) =>
    `${encodeURIComponent(name)}=${encodeURIComponent(String(value).replace(/[!'()*]/g,''))}`).join('&');
  return `${query}&w_rid=${crypto.createHash('md5').update(query+key).digest('hex')}`;
}
export function createUpBiliAdapter(deps: {
  users: Pick<UserStore,'captureAccount'|'isAuthorizationCurrent'>;
  fetch?: typeof fetch; now?: () => number; intervalMs?: number;
}) {
  const request = deps.fetch ?? fetch;
  const now = deps.now ?? Date.now;
  const dmCover = utils.fakeDmCoverImgStr('ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero) (0x0000C0XX)), SwiftShader driver)Google Inc. (Google)');
  let tail = Promise.resolve();
  let nextRequestAt = 0;
  let riskUntil = 0;
  let keys: {key:string; expires:number} | null = null;
  let generation = 0;
  let stopped = false;
  const requests = new Set<AbortController>();

  async function get(user: BiliUser, url: string, epoch: number) {
    if (stopped || epoch !== generation) throw new Error('UP 请求已取消');
    if (riskUntil > now()) throw Object.assign(new Error('B站接口冷却中，请稍后再试'), {statusCode:429});
    const controller = new AbortController();
    requests.add(controller);
    const timeout = setTimeout(() => controller.abort(), 25_000);
    try {
      const wait = Math.max(0,nextRequestAt-now());
      if (wait) await new Promise<void>((resolve,reject) => {
        const timer = setTimeout(done,wait);
        function done() { controller.signal.removeEventListener('abort',cancel); resolve(); }
        function cancel() { clearTimeout(timer); reject(new Error('UP 请求已取消')); }
        controller.signal.addEventListener('abort',cancel,{once:true});
      });
      if (controller.signal.aborted || stopped || epoch !== generation) throw new Error('UP 请求已取消');
      nextRequestAt = now() + (deps.intervalMs ?? 2500);
      const cookie = Object.entries(biliWebCookieValues(user.cookie)).filter(([,value])=>value !== undefined)
        .map(([name,value])=>`${name}=${value}`).join('; ');
      if(/[\r\n\x00-\x1f\x7f]/.test(cookie)) throw new Error('账号 Cookie 格式异常，请更新授权');
      const response = await request(url,{signal:controller.signal,headers:{Cookie:cookie,
        'User-Agent':'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/129.0.0.0 Safari/537.36',
        Referer:'https://space.bilibili.com/', Origin:'https://space.bilibili.com'}});
      if (!response.ok) {
        if ([403,412,429].includes(response.status)) { riskUntil=now()+30*60_000; throw new BiliRiskOrLoginError(`B站接口 HTTP ${response.status}`); }
        throw new Error(`B站接口 HTTP ${response.status}`);
      }
      const body: unknown = await response.json();
      if (!isRecord(body) || typeof body.code!=='number' || !Number.isSafeInteger(body.code)) throw new BiliResponseFormatError('up.code');
      if (body.code!==0) {
        if ([-101,-111,-352,-412].includes(body.code)) { riskUntil=now()+30*60_000; throw new BiliRiskOrLoginError(`B站接口 code ${body.code}`); }
        throw new Error(`B站接口 code ${body.code}`);
      }
      if (!('data' in body)) throw new BiliResponseFormatError('up.data');
      return body.data;
    } finally { clearTimeout(timeout); requests.delete(controller); }
  }
  async function query<T>(userId: string, path: string, parameters: Record<string,string|number>, signed: boolean, decode: (data:unknown)=>T): Promise<T> {
    if (stopped) throw Object.assign(new Error('服务正在停止'),{statusCode:503});
    const epoch = generation;
    const previous = tail;
    let release: () => void = () => {};
    tail = new Promise<void>(resolve => { release=resolve; });
    await previous;
    try {
      const account=deps.users.captureAccount(userId);
      if (!account?.user.enabled) throw Object.assign(new Error('请选择可用的 B站账号'),{statusCode:400});
      let suffix = new URLSearchParams(Object.entries(parameters).map(([key,value])=>[key,String(value)])).toString();
      if (signed) {
        if (!keys || keys.expires<now()) {
          const nav=await get(account.user,'https://api.bilibili.com/x/web-interface/nav',epoch);
          if (!isRecord(nav) || !isRecord(nav.wbi_img) || typeof nav.wbi_img.img_url!=='string' || typeof nav.wbi_img.sub_url!=='string') throw new BiliResponseFormatError('up.wbi_img');
          const joined=[nav.wbi_img.img_url,nav.wbi_img.sub_url].map(value=>new URL(value).pathname.split('/').slice(-1)[0]?.split('.')[0]).join('');
          if (joined.length!==64) throw new BiliResponseFormatError('up.wbi_key');
          keys={key:mixin.map(index=>joined[index]).join('').slice(0,32),expires:now()+6*60*60_000};
        }
        suffix=signUpWbi(parameters,keys.key,Math.floor(now()/1000));
      }
      if(parameters.vmid!==undefined && parameters.vmid!==account.user.uid) throw new Error('授权账号已变化，请重试');
      const result=decode(await get(account.user,`https://api.bilibili.com${path}?${suffix}`,epoch));
      if (stopped || generation!==epoch || !deps.users.isAuthorizationCurrent(account.identity)) throw Object.assign(new Error('账号或请求已变化，请重试'),{statusCode:409});
      return result;
    } finally { release(); }
  }
  return {
    followings: (userId:string,page:number,keyword:string) => query(userId,keyword?'/x/relation/followings/search':'/x/relation/followings',
      {vmid:deps.users.captureAccount(userId)?.user.uid??0,pn:page,ps:50,order:'desc',order_type:'',...(keyword?{name:keyword}:{})},false,data=>decodeUpFollowings(data,page,50)),
    search: (userId:string,keyword:string,page:number) => query(userId,'/x/web-interface/wbi/search/type',
      {search_type:'bili_user',keyword,page,page_size:20,order:0,user_type:0},true,data=>decodeUpSearch(data)),
    profile: (userId:string,uid:number) => query(userId,'/x/web-interface/card',{mid:uid},false,data=>decodeUpCard(data,uid)),
    submissions: (userId:string,uid:number,page:number) => query(userId,'/x/space/wbi/arc/search',
      {mid:uid,pn:page,ps:30,tid:0,special_type:'',order:'pubdate',keyword:'',index:0,order_avoided:'true',platform:'web',web_location:'333.1387',
        dm_img_list:'[]',dm_img_str:'V2ViR0wgMS',dm_cover_img_str:dmCover,dm_img_inter:'{"ds":[],"wh":[0,0,0],"of":[0,0,0]}'},true,data=>decodeUpSubmissions(data,page,30)),
    stop() { stopped=true; generation++; for(const controller of requests) controller.abort(); },
    start() { stopped=false; },
    reset() { generation++; keys=null; for(const controller of requests) controller.abort(); },
    isIdle: () => requests.size===0,
  } satisfies UpBiliPort & {stop():void;start():void;reset():void;isIdle():boolean};
}
