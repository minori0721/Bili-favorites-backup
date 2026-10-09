import type { StateManager } from '../state.js';
import type { BiliUser } from '../users.js';
import type { StoredUpSubscription } from '../repositories/up-subscriptions.js';
import type { UpSubmission } from '../shared/up-subscriptions.js';

export function createUpArchive(deps:{
  state:Pick<StateManager,'recordUpSubscriptionItem'|'listRelationsForBvid'|'restoreExistingArchiveProof'|'runAtomic'>;
  user(id:string):BiliUser|null|undefined;
  eligible(user:BiliUser):boolean;
  blocked(userId:string,mediaId:number,bvid:string):boolean;
  accepting():boolean;
  enqueue(user:BiliUser,route:number,title:string,bvid:string):boolean;
}) {
  return (source:StoredUpSubscription,item:UpSubmission)=> {
    const user=deps.user(source.userId);
    if(!user || !deps.eligible(user) || !deps.accepting() || deps.blocked(user.id,source.routingKey,item.bvid)) return {fresh:false,queued:false};
    return deps.state.runAtomic(()=> {
      const result=deps.state.recordUpSubscriptionItem(source.id,user.id,source.routingKey,`UP · ${source.name}`,{
        bvid:item.bvid,title:item.title,upperName:item.ownerName,upperMid:item.ownerUid,cover:item.cover});
      const proof=deps.state.listRelationsForBvid(item.bvid).find(relation=>
        relation.backupStatus==='verified' && relation.remotePath && relation.remoteFiles?.some(file=>/\.(mp4|mkv|flv|webm|mov)$/i.test(file.name) && file.verificationStatus==='verified')
        && relation.remoteFiles.every(file=>file.verificationStatus==='verified'));
      if(proof?.remoteFiles && proof.remotePath && deps.state.restoreExistingArchiveProof(item.bvid,user.id,source.routingKey,{
        status:'verified',remotePath:proof.remotePath,files:proof.remoteFiles,uploadedAt:proof.uploadedAt,verifiedAt:proof.verifiedAt})) {
        return {fresh:!result.wasKnown,queued:false};
      }
      return {fresh:!result.wasKnown,queued:deps.enqueue(user,source.routingKey,`UP · ${source.name}`,item.bvid)};
    });
  };
}
