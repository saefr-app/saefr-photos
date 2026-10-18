import {Worker, UnrecoverableError} from 'bullmq';
import {Failure} from './protocol.mjs';

export async function processIndex(store,inputs,inference,id) {
  const job=store.claim(id);
  if (!job) return {skipped:true};
  try {
    const reused=store.reusable(job);
    const content=reused?null:await inputs.read(job.input_key,job.request.image);
    const vector=reused??await inference.predict(job.request,content);
    const accepted=store.finish(id,job.request,vector);
    return {accepted};
  } catch (error) {
    const allowed=new Set(['INFERENCE_UNAVAILABLE','INFERENCE_REJECTED','PROTOCOL_MISMATCH','SOURCE_UNAVAILABLE','INVALID_VECTOR']);
    const code=error instanceof Failure && allowed.has(error.code)?error.code:'PROCESSING_FAILED';
    const retry=store.fail(id,code,Boolean(error.retryable));
    if (retry) throw new Error(code);
    if (store.job(id)?.state==='skipped') return {skipped:true};
    throw new UnrecoverableError(code);
  }
}

export function startWorker({store,inputs,inference,queueName,connection,backoff=1000}) {
  const worker=new Worker(queueName,job=>processIndex(store,inputs,inference,job.id),{
    connection,concurrency:1,maxStalledCount:2,lockDuration:60000,
    settings:{backoffStrategy:attempt=>Math.min(60000,backoff*2**Math.max(0,attempt-1))*(0.8+Math.random()*0.2)},
  });
  worker.on('error',()=>{}); // Operational failure is surfaced by health/ledger, never raw Redis diagnostics.
  return worker;
}

export async function reconcile(store,queue) {
  for (const id of store.recoverable()) {
    const job=await queue.getJob(id);
    if (job) {
      const state=await job.getState();
      if (['completed','failed'].includes(state)) await job.remove();
      else continue;
    }
    await queue.add('image-embedding',{id},{jobId:id,attempts:3,
      backoff:{type:'ml-retry'},removeOnComplete:{count:1000,age:86400},removeOnFail:{count:1000,age:86400}});
  }
}
