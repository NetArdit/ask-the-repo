## Build (process A)

| repo | files indexed | skipped | tarball MB (gz) | unpacked MB | symbols | imports | chunks | terms | rel. imports resolved |
|---|---|---|---|---|---|---|---|---|---|
| sindresorhus/ky | 90 | 14 | 0.3 | 1.1 | 328 | 268 | 1002 | 2889 | 164/164 (100%) |
| expressjs/express | 145 | 69 | 0.1 | 0.9 | 595 | 400 | 693 | 2683 | 159/159 (100%) |
| vercel/commerce | 68 | 10 | 0.2 | 0.5 | 188 | 210 | 143 | 1186 | 38/39 (97%) |
| vitejs/vite | 1664 | 1172 | 12.4 | 19.6 | 3682 | 3835 | 4610 | 18690 | 1809/2077 (87%) |
| facebook/react | 6457 | 795 | 9.8 | 44.4 | 16690 | 11080 | 26443 | 44691 | 3992/4365 (91%) |

## Timing (ms) and memory

| repo | stream+gunzip+tar | parse | index add | finish | serialize | write | total ingest | process A wall | peak RSS MB |
|---|---|---|---|---|---|---|---|---|---|
| sindresorhus/ky | 238 | 974 | 229 | 13 | 410 | 200 | 1441 | 3707 | 127 |
| expressjs/express | 196 | 686 | 176 | 12 | 23 | 384 | 1058 | 2784 | 104 |
| vercel/commerce | 46 | 398 | 40 | 5 | 8 | 28 | 484 | 2683 | 97 |
| vitejs/vite | 7251 | 3578 | 1214 | 102 | 1830 | 143 | 12043 | 16980 | 173 |
| facebook/react | 2278 | 30953 | 5761 | 262 | 2542 | 251 | 38992 | 43926 | 350 |

## Parse status by language

| repo | language | ast | ast-with-errors | fallback |
|---|---|---|---|---|
| sindresorhus/ky | typescript | 87 | 0 | 0 |
| expressjs/express | javascript | 141 | 0 | 0 |
| vercel/commerce | tsx | 45 | 0 | 0 |
| vercel/commerce | typescript | 20 | 0 | 0 |
| vercel/commerce | javascript | 1 | 0 | 0 |
| vitejs/vite | typescript | 576 | 7 | 0 |
| vitejs/vite | javascript | 979 | 1 | 0 |
| vitejs/vite | tsx | 17 | 0 | 0 |
| facebook/react | javascript | 2962 | 939 | 0 |
| facebook/react | typescript | 422 | 0 | 0 |
| facebook/react | tsx | 121 | 0 | 0 |

## Artifact and reload (process B)

| repo | artifact KB | json KB | get | decompress | JSON.parse | derive | load total | RSS after load MB | median query ms | max query ms | process B wall |
|---|---|---|---|---|---|---|---|---|---|---|---|
| sindresorhus/ky | 70 | 260 | 5.2 | 4.7 | 4.8 | 5.5 | 20.6 | 69 | 1.43 | 4.58 | 891 |
| expressjs/express | 53 | 189 | 9.9 | 1.8 | 2.2 | 4.1 | 18.3 | 70 | 0.81 | 1.39 | 1985 |
| vercel/commerce | 18 | 64 | 10.5 | 1.4 | 1.2 | 3.7 | 17.2 | 68 | 0.33 | 0.59 | 646 |
| vitejs/vite | 500 | 1838 | 8.8 | 13.3 | 25.7 | 47.8 | 96.0 | 90 | 4.16 | 8.34 | 1267 |
| facebook/react | 2027 | 8793 | 10.5 | 47.4 | 129.1 | 224.5 | 411.8 | 166 | 18.51 | 62.99 | 2940 |

## Aborted builds (limit enforcement on real repositories)

- DefinitelyTyped/DefinitelyTyped: terminated; 46199 ms before abort; peak RSS 1083.1 MB

## Retrieval by variant (positives only; hit@k = any expected evidence in top k)


### bm25

| repo | n | hit@1 | hit@3 | hit@5 | hit@10 | item-recall@10 | precision@5 | MRR |
|---|---|---|---|---|---|---|---|---|
| sindresorhus/ky | 7 | 0% | 0% | 14% | 29% | 21% | 0.06 | 0.06 |
| expressjs/express | 8 | 25% | 38% | 38% | 38% | 28% | 0.13 | 0.29 |
| vercel/commerce | 8 | 38% | 50% | 63% | 75% | 75% | 0.22 | 0.47 |
| vitejs/vite | 9 | 22% | 44% | 44% | 56% | 56% | 0.09 | 0.31 |
| facebook/react | 8 | 0% | 0% | 0% | 13% | 13% | 0.00 | 0.01 |
| **all** | 40 | 18% | 28% | 33% | 43% | 39% | 0.10 | 0.23 |

### bm25+symbols

| repo | n | hit@1 | hit@3 | hit@5 | hit@10 | item-recall@10 | precision@5 | MRR |
|---|---|---|---|---|---|---|---|---|
| sindresorhus/ky | 7 | 43% | 57% | 57% | 71% | 50% | 0.11 | 0.52 |
| expressjs/express | 8 | 38% | 63% | 63% | 63% | 56% | 0.25 | 0.50 |
| vercel/commerce | 8 | 63% | 75% | 75% | 100% | 91% | 0.20 | 0.73 |
| vitejs/vite | 9 | 22% | 56% | 56% | 56% | 56% | 0.16 | 0.35 |
| facebook/react | 8 | 13% | 13% | 13% | 13% | 13% | 0.03 | 0.13 |
| **all** | 40 | 35% | 53% | 53% | 60% | 53% | 0.15 | 0.44 |

### bm25+symbols+paths

| repo | n | hit@1 | hit@3 | hit@5 | hit@10 | item-recall@10 | precision@5 | MRR |
|---|---|---|---|---|---|---|---|---|
| sindresorhus/ky | 7 | 29% | 57% | 57% | 71% | 43% | 0.11 | 0.43 |
| expressjs/express | 8 | 38% | 50% | 50% | 63% | 56% | 0.18 | 0.46 |
| vercel/commerce | 8 | 75% | 75% | 100% | 100% | 86% | 0.30 | 0.81 |
| vitejs/vite | 9 | 33% | 67% | 67% | 67% | 67% | 0.22 | 0.46 |
| facebook/react | 8 | 13% | 25% | 25% | 25% | 25% | 0.05 | 0.17 |
| **all** | 40 | 38% | 55% | 60% | 65% | 56% | 0.18 | 0.46 |

### full (+import expansion)

| repo | n | hit@1 | hit@3 | hit@5 | hit@10 | item-recall@10 | precision@5 | MRR |
|---|---|---|---|---|---|---|---|---|
| sindresorhus/ky | 7 | 29% | 43% | 43% | 86% | 48% | 0.09 | 0.41 |
| expressjs/express | 8 | 38% | 50% | 50% | 63% | 56% | 0.15 | 0.46 |
| vercel/commerce | 8 | 88% | 88% | 100% | 100% | 80% | 0.30 | 0.90 |
| vitejs/vite | 9 | 33% | 67% | 67% | 67% | 67% | 0.20 | 0.44 |
| facebook/react | 8 | 13% | 25% | 25% | 25% | 25% | 0.05 | 0.17 |
| **all** | 40 | 40% | 55% | 57% | 68% | 56% | 0.16 | 0.48 |

## Retrieval by category (full variant)

| category | n | hit@1 | hit@5 | hit@10 |
|---|---|---|---|---|
| where | 15 | 40% | 53% | 60% |
| entry-point | 5 | 20% | 20% | 20% |
| flow | 5 | 40% | 60% | 60% |
| files | 4 | 75% | 100% | 100% |
| imports | 4 | 0% | 50% | 100% |
| ambiguous | 3 | 33% | 67% | 100% |
| conceptual | 3 | 67% | 67% | 67% |
| endpoint | 1 | 100% | 100% | 100% |

## Negative-case signal (idf-weighted query-term coverage of the top-3 evidence)

| repo | negative question | idf coverage | top score |
|---|---|---|---|
| sindresorhus/ky | ky-8 | 0.09 | 1.23 |
| expressjs/express | ex-9 | 0.00 | 0.00 |
| vercel/commerce | co-9 | 0.29 | 1.00 |
| vitejs/vite | vi-10 | 0.48 | 1.38 |
| facebook/react | re-9 | 0.43 | 1.00 |

positives: n=40, min coverage 0.17, mean 0.83
best single threshold (fit on this same set, so optimistic): {"threshold":0.1703154832642898,"accuracy":0.9333333333333333}

| refuse if coverage < | negatives refused | positives wrongly refused |
|---|---|---|
| 0.1 | 2/5 | 0/40 |
| 0.2 | 2/5 | 1/40 |
| 0.3 | 3/5 | 2/40 |
| 0.4 | 3/5 | 5/40 |
| 0.5 | 5/5 | 8/40 |
| 0.6 | 5/5 | 9/40 |

## Per-question detail (full variant)


### sindresorhus/ky
- ky-1 [where] rank=8 terms=retry,delay,calculated
  - test/retry.ts:2213-2246 s=1.19
  - source/utils/delay.ts:1-29 s=1.10
  - source/types/retry.ts:20-70 s=1.04
- ky-2 [where] rank=1 terms=httperror,http,error
  - source/errors/HTTPError.ts:1-34 s=1.92
  - source/errors/KyError.ts:1-14 s=1.91
  - test/http-error.ts:130-149 s=1.50
- ky-3 [entry-point] rank=miss terms=entry,point,library
  - test/main.ts:643-668 s=1.00
  - source/utils/types.ts:1-7 s=0.84
  - source/core/Ky.ts:359-374 s=0.62
- ky-4 [flow] rank=1 terms=ky,request,timeout
  - source/utils/timeout.ts:1-36 s=1.72
  - source/core/Ky.ts:177-228 s=1.48
  - source/errors/TimeoutError.ts:1-15 s=1.45
- ky-5 [files] rank=2 terms=beforerequest,request,afterresponse,response,hook
  - test-d/hooks.ts:1-15 s=1.54
  - source/types/hooks.ts:85-137 s=1.34
  - test/hooks.ts:159-194 s=1.20
- ky-6 [imports] rank=8 terms=httperror,http,error
  - source/errors/HTTPError.ts:1-34 s=1.92
  - source/errors/KyError.ts:1-14 s=1.91
  - test/http-error.ts:130-149 s=1.50
- ky-7 [ambiguous] rank=9 terms=create
  - test/helpers/create-large-file.ts:1-7 s=1.40
  - test/helpers/index.ts:1-4 s=1.33
  - test/stream.ts:1-23 s=1.33
- ky-8 [negative] rank=miss terms=ky,manage,postgresql,postgre,sql,connection,pooling
  - source/core/Ky.ts:1241-1258 s=1.23
  - source/errors/NetworkError.ts:1-19 s=1.18
  - test/hooks.ts:2351-2380 s=1.00

### expressjs/express
- ex-1 [where] rank=1 terms=res,json
  - lib/response.js:223-250 s=1.89
  - examples/content-negotiation/users.js:16-19 s=1.84
  - test/res.json.js:107-156 s=1.48
- ex-2 [entry-point] rank=miss terms=entry,point,express,application,created
  - test/res.sendStatus.js:1-44 s=1.42
  - test/express.raw.js:1-59 s=1.32
  - test/app.use.js:1-57 s=1.31
- ex-3 [where] rank=miss terms=app,start,listening,port
  - test/app.listen.js:1-55 s=1.06
  - examples/hello-world/index.js:1-15 s=1.05
  - examples/multi-router/index.js:1-18 s=1.01
- ex-4 [flow] rank=miss terms=request,arrive,dispatched,router
  - test/acceptance/multi-router.js:1-44 s=1.53
  - test/req.baseUrl.js:1-55 s=1.50
  - test/app.router.js:1-60 s=1.49
- ex-5 [files] rank=1 terms=view,rendering,template,engine
  - lib/view.js:51-95 s=1.36
  - examples/view-constructor/index.js:25-42 s=1.28
  - lib/view.js:35-50 s=1.20
- ex-6 [imports] rank=7 terms=router,package
  - test/Router.js:1-58 s=1.87
  - test/Router.js:159-208 s=1.27
  - test/Router.js:409-458 s=1.26
- ex-7 [conceptual] rank=1 terms=user,authentication,demonstrated,password,session
  - examples/auth/index.js:1-16 s=1.21
  - examples/session/redis.js:1-15 s=1.16
  - examples/session/index.js:1-15 s=1.15
- ex-8 [ambiguous] rank=2 terms=send
  - lib/response.js:31-48 s=1.79
  - lib/response.js:125-175 s=1.59
  - test/res.send.js:1-61 s=1.50
- ex-9 [negative] rank=miss terms=kubernete,autoscaler,configured
  - 

### vercel/commerce
- co-1 [endpoint] rank=1 terms=revalidate,api,endpoint
  - lib/shopify/index.ts:504-543 s=1.42
  - lib/constants.ts:42-51 s=1.35
  - lib/shopify/index.ts:60-123 s=1.31
- co-2 [where] rank=1 terms=shopifyfetch,shopify,fetch
  - lib/shopify/index.ts:60-123 s=1.64
  - lib/shopify/index.ts:425-441 s=1.50
  - lib/shopify/index.ts:219-240 s=1.42
- co-3 [flow] rank=1 terms=user,add,item,cart
  - components/cart/actions.ts:1-29 s=1.71
  - components/cart/cart-context.tsx:192-238 s=1.39
  - components/cart/add-to-cart.tsx:59-94 s=1.29
- co-4 [files] rank=1 terms=product,page
  - app/product/[handle]/page.tsx:49-111 s=1.65
  - app/[page]/page.tsx:25-50 s=1.53
  - lib/shopify/types.ts:235-252 s=1.27
- co-5 [where] rank=1 terms=redirect,checkout
  - components/cart/actions.ts:97-106 s=1.32
  - components/cart/modal.tsx:243-256 s=0.77
  - components/cart/modal.tsx:1-15 s=0.63
- co-6 [entry-point] rank=1 terms=entry,point,app,home,page,root,layout
  - app/page.tsx:1-21 s=1.94
  - app/layout.tsx:24-47 s=1.54
  - app/[page]/layout.tsx:1-12 s=1.48
- co-7 [conceptual] rank=1 terms=cart,state,managed,client
  - components/cart/cart-context.tsx:1-15 s=1.63
  - components/cart/actions.ts:30-52 s=1.60
  - components/cart/modal.tsx:1-15 s=1.50
- co-8 [imports] rank=5 terms=getcart,cart,shopify
  - lib/shopify/index.ts:269-292 s=1.90
  - lib/shopify/queries/cart.ts:1-10 s=1.42
  - lib/shopify/mutations/cart.ts:1-23 s=1.33
- co-9 [negative] rank=miss terms=user,authentication,login
  - app/robots.ts:1-13 s=1.00

### vitejs/vite
- vi-1 [where] rank=miss terms=dev,server,created
  - playground/hmr-full-bundle-mode/__tests__/build-hooks.spec.ts:1-15 s=1.19
  - playground/vitestSetup.ts:75-90 s=1.19
  - packages/vite/src/node/__tests__/optimizer/customExtensionBundleClose.spec.ts:1-16 s=1.18
- vi-2 [where] rank=1 terms=resolveconfig,resolve,config
  - packages/vite/src/node/config.ts:1488-1538 s=1.43
  - packages/vite/src/node/build.ts:567-595 s=1.11
  - packages/vite/src/node/plugins/index.ts:36-91 s=1.08
- vi-3 [where] rank=miss terms=hot,replacement,server
  - packages/vite/src/node/plugins/clientInjections.ts:72-145 s=1.20
  - docs/guide/api-hmr.md:251-260 s=1.00
  - packages/vite/src/node/utils.ts:1641-1677 s=0.93
- vi-4 [entry-point] rank=miss terms=command,line,entry,point
  - scripts/mergeChangelog.ts:184-199 s=1.12
  - packages/vite/src/node/plugins/resolve.ts:962-1001 s=1.00
  - packages/vite/src/node/utils.ts:214-230 s=1.00
- vi-5 [where] rank=1 terms=production,build
  - packages/vite/src/node/build.ts:567-595 s=2.10
  - packages/vite/src/node/config.ts:2089-2138 s=1.40
  - packages/vite/src/node/__tests__/build.spec.ts:1408-1458 s=1.36
- vi-6 [files] rank=1 terms=css,processing
  - packages/vite/src/node/plugins/css.ts:1583-1633 s=1.42
  - packages/vite/src/node/constants.ts:210-227 s=1.11
  - docs/guide/api-javascript.md:451-489 s=1.00
- vi-7 [where] rank=3 terms=package,scaffold,project,template
  - packages/create-vite/__tests__/cli.spec.ts:34-51 s=1.08
  - docs/guide/index.md:101-150 s=1.00
  - packages/create-vite/src/index.ts:404-430 s=0.98
- vi-8 [flow] rank=3 terms=websocket,web,socket,server,hmr,created
  - packages/vite/src/node/server/index.ts:118-168 s=1.50
  - packages/vite/src/client/client.ts:32-110 s=1.29
  - packages/vite/src/node/server/ws.ts:74-89 s=1.29
- vi-9 [imports] rank=3 terms=command,cli,create,dev,server
  - packages/vite/src/node/server/index.ts:512-562 s=1.21
  - packages/create-vite/__tests__/cli.spec.ts:1-15 s=1.17
  - packages/vite/src/node/cli.ts:200-251 s=1.14
- vi-10 [negative] rank=miss terms=vue,single,component,compiler
  - playground/optimize-deps/vite.config.js:77-104 s=1.38
  - docs/.vitepress/theme/index.ts:1-33 s=1.00
  - playground/shims.d.ts:1-15 s=0.97

### facebook/react
- re-1 [where] rank=miss terms=usestate,state
  - compiler/packages/babel-plugin-react-compiler/src/__tests__/fixtures/compiler/globals-dont-resolve-local-useState.js:1-18 s=1.87
  - packages/react-reconciler/src/__tests__/ActivityErrorHandling-test.js:1-58 s=1.73
  - packages/react-reconciler/src/__tests__/ReactInterleavedUpdates-test.js:1-61 s=1.71
- re-2 [where] rank=3 terms=beginwork,begin,reconciler
  - packages/react-reconciler/src/ReactFiberBeginWork.js:4506-4511 s=1.50
  - packages/react-reconciler/src/ReactFiberBeginWork.js:3425-3475 s=1.17
  - packages/react-reconciler/src/ReactFiberBeginWork.js:4208-4245 s=1.17
- re-3 [where] rank=miss terms=scheduler,schedule,callback
  - packages/react-reconciler/src/Scheduler.js:1-16 s=1.75
  - packages/react-reconciler/src/ReactFiberRootScheduler.js:640-696 s=1.63
  - packages/scheduler/src/__tests__/SchedulerMock-test.js:16-78 s=1.57
- re-4 [entry-point] rank=miss terms=entry,point,react,package
  - compiler/packages/react-forgive/scripts/client.mjs:1-15 s=1.06
  - compiler/packages/react-forgive/scripts/server.mjs:1-15 s=1.06
  - compiler/scripts/test-rust-port.ts:149-165 s=1.00
- re-5 [where] rank=miss terms=createroot,create,root,react,dom
  - packages/react-devtools-cdt-mcp/fixtures/app/index.js:1-12 s=1.51
  - packages/react-devtools-shell/src/e2e/app.js:1-16 s=1.43
  - packages/react-dom/src/__tests__/ReactLegacyRootWarnings-test.js:1-29 s=1.43
- re-6 [flow] rank=miss terms=commit,phase,start,rendering
  - packages/react-reconciler/src/__tests__/ReactSuspenseyCommitPhase-test.js:365-414 s=1.01
  - packages/react-reconciler/src/ReactFiberWorkLoop.js:4150-4180 s=1.00
  - packages/react-reconciler/src/ReactFiberCommitEffects.js:949-1042 s=1.00
- re-7 [conceptual] rank=miss terms=effect,mounted,useeffect,hook
  - packages/react-reconciler/src/__tests__/ReactSubtreeFlagsWarning-test.js:1-62 s=1.61
  - packages/react-reconciler/src/__tests__/ReactEffectOrdering-test.js:16-90 s=1.49
  - packages/react-reconciler/src/__tests__/Activity-test.js:1-15 s=1.43
- re-8 [ambiguous] rank=1 terms=createelement,create,element
  - packages/react/src/jsx/ReactJSXElement.js:605-659 s=1.65
  - packages/react/src/__tests__/ReactCreateElement-test.js:221-270 s=1.45
  - packages/react/src/__tests__/ReactCreateElement-test.js:16-70 s=1.44
- re-9 [negative] rank=miss terms=kubernete,pod,autoscaler,configured
  - packages/react-server-dom-webpack/src/ReactFlightWebpackPlugin.js:228-246 s=1.00
  - fixtures/view-transition/src/components/SwipeRecognizer.js:1-16 s=0.98
  - packages/react-server/src/ReactSharedInternalsServer.js:18-27 s=0.82

## Acquisition comparison

| repo | tarball: HTTP req | tarball: REST quota used | tarball: MB gz | tarball: ms | tarball: failure | trees: req | trees: entries | truncated | blobs needed | blob req ms (avg, sample) | trees REST quota used |
|---|---|---|---|---|---|---|---|---|---|---|---|
| sindresorhus/ky | 1 | 0 | 0.3 | 659 | none | 1 | 115 | false | 90 | 256 (n=5) | 6 |
| expressjs/express | 1 | 0 | 0.1 | 476 | none | 1 | 282 | false | 145 | 279 (n=5) | 6 |
| vercel/commerce | 1 | 0 | 0.2 | 494 | none | 1 | 102 | false | 68 | 242 (n=5) | 6 |
| vitejs/vite | 1 | 0 | 12.4 | 2213 | none | 1 | 3754 | false | 1667 | 271 (n=5) | 6 |
| facebook/react | 1 | 0 | 9.8 | 2041 | none | 2 | 7893 | false | 6466 | n/a | 2 |
| DefinitelyTyped/DefinitelyTyped | 1 | n/a | 0.0 | 0 | see bench: acquisition aborted | 1 | 74225 | false | 33466 | n/a | 1 |
