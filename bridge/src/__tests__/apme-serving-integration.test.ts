import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ApmeStore } from '../apme/store.js';
import { ApmeRunner, callJudgeWithMeta } from '../apme/runner.js';
import { ApmeCollector } from '../apme/collector.js';
import { DEFAULT_APME_CONFIG } from '../apme/settings.js';

const answer = JSON.stringify({completion:0.8,coherence:0.8,efficiency:0.7,overall:0.8,
  summary:'Added regression coverage.',reasoning:'The requested test was added.',done:['test'],missed:[]});
const response = () => new Response(JSON.stringify({choices:[{message:{content:answer},finish_reason:'stop'}]}));

describe('Ollama-compatible task judge persistence and recovery', () => {
  let dir: string;
  let store: ApmeStore;
  let runner: ApmeRunner;
  let runId: string;
  let taskId: string;
  beforeEach(async () => {
    dir=mkdtempSync(join(tmpdir(),'ad-serving-test-'));
    store=new ApmeStore(join(dir,'apme.sqlite'));
    expect(await store.init()).toBe(true);
    const collector=new ApmeCollector(store);
    runId=collector.openRun({sessionId:'serving-test',agentType:'claude-code',projectName:'fixture'})!;
    collector.ingestHook('serving-test','UserPromptSubmit',{prompt:'Add a regression test for missing configuration files.'});
    collector.setTurnResponse('serving-test','Added and ran the regression test. The missing-file path now returns the default configuration.');
    collector.closeTaskExternal('serving-test','manual');
    taskId=store.listTasksForRun(runId)[0].id;
    runner=new ApmeRunner(store);
    runner._setConfig({...DEFAULT_APME_CONFIG,enabled:true,deterministic:{enabled:false,timeoutSec:1,commands:{}},
      judge:{backend:'openai',model:'foundby-gemma4-ad:16k',endpoint:'http://127.0.0.1:11434/v1',
        reasoningEffort:'none',fallbackToMlx:false,fallbackToFoundationModels:false}});
  });
  afterEach(()=>{vi.unstubAllGlobals();vi.restoreAllMocks();store.close();rmSync(dir,{recursive:true,force:true});});
  async function settled() {
    await vi.waitFor(()=>expect(runner.inFlightTaskEvals).toBe(0));
  }
  it.each(['http','json','timeout','length'])('leaves no score after %s failure and persists on recovery', async kind => {
    const fetcher=vi.fn().mockImplementationOnce(async (_url, options) => {
      expect(options.signal).toBeInstanceOf(AbortSignal);
      expect(JSON.parse(options.body).reasoning_effort).toBe('none');
      if(kind==='http')return new Response('unavailable',{status:503});
      if(kind==='json')return new Response(JSON.stringify({choices:[{message:{content:'not JSON'}}]}));
      if(kind==='length')return new Response(JSON.stringify({choices:[{message:{content:answer},finish_reason:'length'}]}));
      throw new DOMException('request timed out','TimeoutError');
    }).mockImplementation(async()=>response());
    vi.stubGlobal('fetch',fetcher);
    runner.enqueueTask({runId,taskId});await settled();
    expect(store.listEvalsForTask(taskId)).toHaveLength(0);
    expect(store.getTask(taskId)?.compositeScore).toBeNull();
    let storedAtEvent=0;
    runner.onTaskEvaluated(()=>{storedAtEvent=store.listEvalsForTask(taskId).length;});
    runner.enqueueTask({runId,taskId});await settled();
    const rows=store.listEvalsForTask(taskId).filter(r=>r.layer==='task_judge');
    expect(rows.map(r=>r.metric).sort()).toEqual(['coherence','completion','efficiency','overall']);
    expect(rows.every(r=>r.judgeModel==='openai:foundby-gemma4-ad:16k')).toBe(true);
    expect(storedAtEvent).toBe(store.listEvalsForTask(taskId).length);
    expect(store.getTask(taskId)?.summary).toBe('Added regression coverage.');
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
  it('coalesces duplicate in-flight task requests',async()=>{
    let release!:()=>void;
    const latch=new Promise<void>(r=>{release=r;});
    const fetcher=vi.fn(async()=>{await latch;return response();});
    vi.stubGlobal('fetch',fetcher);
    runner.enqueueTask({runId,taskId});runner.enqueueTask({runId,taskId});
    await vi.waitFor(()=>expect(fetcher).toHaveBeenCalledTimes(1));
    release();await settled();
    expect(store.listEvalsForTask(taskId).filter(r=>r.layer==='task_judge')).toHaveLength(4);
  });
});


describe('incomplete judge response',()=>{
  afterEach(()=>vi.unstubAllGlobals());
  it.each(['mlx','openai'] as const)('%s rejects a length-limited JSON response',async backend=>{
    vi.stubGlobal('fetch',vi.fn(async()=>new Response(JSON.stringify({choices:[{message:{content:answer},finish_reason:'length'}]}))));
    await expect(callJudgeWithMeta('judge',{...DEFAULT_APME_CONFIG.judge,backend,model:'gemma-test',endpoint:'http://127.0.0.1:8800/v1/chat/completions',fallbackToMlx:false,fallbackToFoundationModels:false})).rejects.toThrow(/output limit/);
  });
});
