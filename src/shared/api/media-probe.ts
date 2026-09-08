import { isRecord } from './value.js';

/** Fields needed to choose and refine one strict media combination. */
export function parseProbeCombination(value: unknown) {
  if (!isRecord(value) || typeof value.available !== 'boolean') throw new Error('媒体组合格式错误');
  const text = (key: string) => {
    const item = value[key];
    if (item == null) return undefined;
    if (typeof item !== 'string') throw new Error('媒体组合说明格式错误');
    return item;
  };
  const number = (key: string) => {
    const item = value[key];
    if (item == null) return undefined;
    if (typeof item !== 'number' || !Number.isFinite(item) || item < 0) throw new Error('媒体组合数值格式错误');
    return item;
  };
  const frameRate = value.frameRate;
  if (frameRate != null && typeof frameRate !== 'string' && (typeof frameRate !== 'number' || !Number.isFinite(frameRate) || frameRate < 0)) throw new Error('媒体帧率格式错误');
  return {
    available: value.available, quality: text('quality'), bilibiliQuality: text('bilibiliQuality'), encoding: text('encoding'),
    resolution: text('resolution'), frameRate, sizeSource: text('sizeSource'),
    totalSizeSource: text('totalSizeSource'), totalBytesKind: text('totalBytesKind'), totalSizeConfidence: text('totalSizeConfidence'),
    totalBytes: number('totalBytes'), totalVideoBytes: number('totalVideoBytes'), estimatedBytes: number('estimatedBytes'),
    peakBytes: number('peakBytes'), pageCount: number('pageCount'), availablePageCount: number('availablePageCount'),
  };
}

export function parseProbeResult(value: unknown) {
  const summary = parseProbeSummary(value);
  if (!isRecord(value)) throw new Error('媒体探测结果格式错误');
  return { ...summary, combinations: (Array.isArray(value.combinations) ? value.combinations : []).map(parseProbeCombination) };
}

export function parseProbeReference(value:unknown): string {
  if (!isRecord(value) || typeof value.probeId !== 'string' || !value.probeId) throw new Error('媒体探测任务格式错误');
  return value.probeId;
}

export function parseProbeSummary(value:unknown) {
  if (!isRecord(value) || !['running','complete','failed'].includes(String(value.status))) throw new Error('媒体探测状态格式错误');
  const number = (key:string) => {
    const item=value[key];
    if(item===undefined || item===null)return undefined;
    if(typeof item!=='number'||!Number.isFinite(item)||item<0)throw new Error('媒体探测大小格式错误');
    return item;
  };
  const text = (key:string) => {
    const item=value[key];
    if(item===undefined)return '';
    if(typeof item!=='string')throw new Error('媒体探测说明格式错误');
    return item;
  };
  if(value.pages!==undefined&&!Array.isArray(value.pages))throw new Error('媒体探测分P格式错误');
  if(value.combinations!==undefined&&!Array.isArray(value.combinations))throw new Error('媒体探测组合格式错误');
  const combinations = (Array.isArray(value.combinations)?value.combinations:[]).map((item:unknown)=>{
    if(!isRecord(item)||typeof item.available!=='boolean')throw new Error('媒体探测可用性格式错误');
    return {available:item.available};
  });
  return {status:text('status'),error:text('error'),pageCount:Array.isArray(value.pages)?value.pages.length:0,combinations,
    estimatedBytes:number('estimatedBytes'),estimatedPeakBytes:number('estimatedPeakBytes'),cacheAvailableBytes:number('cacheAvailableBytes'),
    estimatedBytesSource:text('estimatedBytesSource'),estimatedBytesKind:text('estimatedBytesKind')};
}
