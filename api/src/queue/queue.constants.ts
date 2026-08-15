export const ASSET_PROCESSING_QUEUE = 'asset-processing';
export const PROCESS_ASSET_JOB = 'process-asset';

export interface ProcessAssetJobData {
  assetId: string;
  storageKey: string;
}
