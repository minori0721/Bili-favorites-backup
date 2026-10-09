import { ResponseFormatError } from './value.js';
/** Legacy negative routing keys are accepted only with an explicit, stable UP identity. */
export function parseArchiveSourceIdentity(value:Record<string,unknown>) {
  const kind=value.sourceKind,id=value.sourceId,key=value.mediaId;
  if(kind!==undefined&&kind!=='favorite'&&kind!=='manual'&&kind!=='up')throw new ResponseFormatError('归档来源类型无效');
  if(id!==undefined&&(typeof id!=='string'||!id))throw new ResponseFormatError('归档来源标识无效');
  if(typeof key!=='number'||!Number.isSafeInteger(key))throw new ResponseFormatError('归档来源编号无效');
  if(key<-1&&(kind!=='up'||typeof id!=='string'||!id))throw new ResponseFormatError('UP 归档来源身份缺失');
  if(kind==='up'&&(key>-2||typeof id!=='string'||!id))throw new ResponseFormatError('UP 归档来源映射无效');
  return {mediaId:key,sourceKind:kind,sourceId:id};
}
