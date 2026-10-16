import gzip, hashlib, json, math, random, statistics, sys
from pathlib import Path
inputPath=Path(sys.argv[1])
outputPath=Path(sys.argv[2])
harnessPath=Path(__file__).with_name('benchmark.mjs')
contents=inputPath.read_bytes()
data=json.loads(gzip.decompress(contents) if inputPath.suffix=='.gz' else contents)
summary={'method':'Ratio of paired block means; 20,000 paired block bootstrap resamples, fixed seed 2442; percentile 95% intervals. Each block averages 120 frames. Frame samples are not treated as independent observations. Two opposite context-creation orders per A/B scenario.','harnessSha256':hashlib.sha256(harnessPath.read_bytes()).hexdigest(),'scenarios':{}}
for scenario in dict.fromkeys(run['scenario'] for run in data['runs']):
    runs=[run for run in data['runs'] if run['scenario']==scenario]
    base='control' if scenario.startswith('aa-') else 'baseline'
    pairs=[block['means'] for run in runs for block in run['blocks']]
    result={'pairedBlocks':len(pairs),'framesPerVariant':len(pairs)*120,'metrics':{},'perRun':[]}
    for metric in ['flushMs','advanceMs','totalMs']:
        xs=[pair[base][metric] for pair in pairs]
        ys=[pair['optimized'][metric] for pair in pairs]
        rng=random.Random(2442)
        bootstrap=[]
        for _ in range(20000):
            indexes=rng.choices(range(len(pairs)),k=len(pairs))
            bootstrap.append(100*(sum(ys[i] for i in indexes)/sum(xs[i] for i in indexes)-1))
        bootstrap.sort()
        result['metrics'][metric]={'baselineMeanMs':statistics.mean(xs),'optimizedMeanMs':statistics.mean(ys),'differenceMs':statistics.mean(ys)-statistics.mean(xs),'changePercent':100*(statistics.mean(ys)/statistics.mean(xs)-1),'change95PercentCI':[bootstrap[499],bootstrap[19499]],'baselineP95FrameMs':sorted(value for run in runs for block in run['blocks'] for value in block['samples'][base][metric])[math.ceil(len(pairs)*120*.95)-1],'optimizedP95FrameMs':sorted(value for run in runs for block in run['blocks'] for value in block['samples']['optimized'][metric])[math.ceil(len(pairs)*120*.95)-1]}
    for run in runs:
        xs=[block['means'][base]['flushMs'] for block in run['blocks']]
        ys=[block['means']['optimized']['flushMs'] for block in run['blocks']]
        result['perRun'].append({'creationOrder':run['builds'],'baselineMeanMs':statistics.mean(xs),'optimizedMeanMs':statistics.mean(ys),'flushChangePercent':100*(statistics.mean(ys)/statistics.mean(xs)-1)})
    result['glCalls']={name:runs[0]['glCalls'][name]['total'] for name in [base,'optimized']}
    result['pixelComparisons']=sum(len(run['parity']) for run in runs)
    result['changedPixelBytes']=sum(item['changedBytes'] for run in runs for item in run['parity'])
    summary['scenarios'][scenario]=result
outputPath.write_text(json.dumps(summary,indent=2)+'\n')
for name,result in summary['scenarios'].items():
    metric=result['metrics']['flushMs']
    print(f"{name}: {metric['baselineMeanMs']:.4f} -> {metric['optimizedMeanMs']:.4f} ms, {metric['changePercent']:.2f}% ({metric['change95PercentCI'][0]:.2f}, {metric['change95PercentCI'][1]:.2f}); GL {result['glCalls']}; pixels changed {result['changedPixelBytes']}")
    for run in result['perRun']: print(' ',run)
