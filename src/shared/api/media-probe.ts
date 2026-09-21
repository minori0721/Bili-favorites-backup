import { isRecord, ResponseFormatError } from './value.js';

/** Fields needed to choose and refine one strict media combination. */
export function parseProbeCombination(value: unknown) {
  if (!isRecord(value) || typeof value.available !== 'boolean') throw new ResponseFormatError('媒体组合格式错误');
  const text = (key: string) => {
    const item = value[key];
    if (item == null) return undefined;
    if (typeof item !== 'string') throw new ResponseFormatError('媒体组合说明格式错误');
    return item;
  };
  const number = (key: string) => {
    const item = value[key];
    if (item == null) return undefined;
    if (typeof item !== 'number' || !Number.isFinite(item) || item < 0) throw new ResponseFormatError('媒体组合数值格式错误');
    return item;
  };
  const frameRate = value.frameRate;
  if (frameRate != null && typeof frameRate !== 'string' && (typeof frameRate !== 'number' || !Number.isFinite(frameRate) || frameRate < 0)) throw new ResponseFormatError('媒体帧率格式错误');
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
  if (!isRecord(value)) throw new ResponseFormatError('媒体探测结果格式错误');
  // A running/failed probe has no usable combinations. This is a valid
  // optional result, distinct from a malformed complete response.
  if (summary.status !== 'complete') return {...summary, combinations: []};
  if (!Array.isArray(value.combinations)) throw new ResponseFormatError('媒体探测结果缺少组合');
  return { ...summary, combinations: value.combinations.map(parseProbeCombination) };
}

export function parseProbeReference(value:unknown): string {
  if (!isRecord(value) || typeof value.probeId !== 'string' || !value.probeId) throw new ResponseFormatError('媒体探测任务格式错误');
  return value.probeId;
}

export function parseProbeSummary(value:unknown) {
  if (!isRecord(value) || (value.status !== 'running' && value.status !== 'complete' && value.status !== 'failed')) throw new ResponseFormatError('媒体探测状态格式错误');
  const status = value.status;
  if (status === 'failed' && (typeof value.error !== 'string' || !value.error)) throw new ResponseFormatError('失败的媒体探测缺少原因');
  if (value.status === 'complete' && (!Array.isArray(value.pages) || !Array.isArray(value.combinations))) throw new ResponseFormatError('完整媒体探测缺少结果');
  const number = (key:string) => {
    const item=value[key];
    if(item===undefined || item===null)return undefined;
    if(typeof item!=='number'||!Number.isFinite(item)||item<0)throw new ResponseFormatError('媒体探测大小格式错误');
    return item;
  };
  const text = (key:string) => {
    const item=value[key];
    if(item===undefined)return '';
    if(typeof item!=='string')throw new ResponseFormatError('媒体探测说明格式错误');
    return item;
  };
  if(value.pages!==undefined&&!Array.isArray(value.pages))throw new ResponseFormatError('媒体探测分P格式错误');
  if(value.combinations!==undefined&&!Array.isArray(value.combinations))throw new ResponseFormatError('媒体探测组合格式错误');
  const rawCombinations = value.combinations;
  const combinationValues = rawCombinations === undefined ? [] : Array.isArray(rawCombinations) ? rawCombinations : (() => { throw new ResponseFormatError('媒体探测组合格式错误'); })();
  const combinations = combinationValues.map((item:unknown)=>{
    if(!isRecord(item)||typeof item.available!=='boolean')throw new ResponseFormatError('媒体探测可用性格式错误');
    return {available:item.available};
  });
  return {status,error:text('error'),pageCount:Array.isArray(value.pages)?value.pages.length:0,combinations,
    estimatedBytes:number('estimatedBytes'),estimatedPeakBytes:number('estimatedPeakBytes'),cacheAvailableBytes:number('cacheAvailableBytes'),
    estimatedBytesSource:text('estimatedBytesSource'),estimatedBytesKind:text('estimatedBytesKind')};
}
