# Changelog

## [1.13.0](https://github.com/teamupstart/mission-control/compare/v1.12.0...v1.13.0) (2026-09-09)


### Features

* **mcp:** report product feedback through shared issue facilities ([#965](https://github.com/teamupstart/mission-control/issues/965)) ([d29f0f1](https://github.com/teamupstart/mission-control/commit/d29f0f17c6fb8abd81bc6b29448727b06e9d5885))
* **schedules:** let a recurring mission choose its after-work Workflow ([#968](https://github.com/teamupstart/mission-control/issues/968)) ([2c227e5](https://github.com/teamupstart/mission-control/commit/2c227e538fd9ad3d17a8e96a9b7778547be5674c))
* **task-sources:** write a swept task's pull request and outcome back to its issue ([#953](https://github.com/teamupstart/mission-control/issues/953)) ([42008de](https://github.com/teamupstart/mission-control/commit/42008dedc17f1a2fa5af30ec50fe32c100587360))
* **workflows:** carry sufficient evidence across review rounds ([#969](https://github.com/teamupstart/mission-control/issues/969)) ([8761645](https://github.com/teamupstart/mission-control/commit/87616450c3fe45c868ae099ed4df7480490e3d52))
* **workflows:** scope coverage out of Persona judgment and bound the evidence preflight loop ([#963](https://github.com/teamupstart/mission-control/issues/963)) ([e83d0c5](https://github.com/teamupstart/mission-control/commit/e83d0c5f4d929281c6ee4a2e5b3c254d3454b563))


### Bug Fixes

* **goal:** retry transport failures instead of recording them as verdicts ([#962](https://github.com/teamupstart/mission-control/issues/962)) ([35a55df](https://github.com/teamupstart/mission-control/commit/35a55dfc750ff8f2067a111b93aa7ac8ea76fc85))
* **terminal:** accept a Herdr newer than the supported protocol floor ([#967](https://github.com/teamupstart/mission-control/issues/967)) ([5c70299](https://github.com/teamupstart/mission-control/commit/5c70299326c54e8c82a868f92a4852da255c7340))
* **terminal:** accept the Herdr 0.9.0 pane.split response type ([#970](https://github.com/teamupstart/mission-control/issues/970)) ([9d7074d](https://github.com/teamupstart/mission-control/commit/9d7074d6371474f20c571a0a45ccb801b154a4f6))
* **workflows:** give withCaptureLock real mutual exclusion ([#966](https://github.com/teamupstart/mission-control/issues/966)) ([667d4fc](https://github.com/teamupstart/mission-control/commit/667d4fc7b6366c822c09a114d842f0242614e91c))

## [1.12.0](https://github.com/teamupstart/mission-control/compare/v1.11.0...v1.12.0) (2026-09-09)


### Features

* **workflows:** add Test Coverage Judge to No-Mistakes Review ([#958](https://github.com/teamupstart/mission-control/issues/958)) ([98bc3ac](https://github.com/teamupstart/mission-control/commit/98bc3ac15e0c5c4d8e8deed57790fb4146fdacea))


### Bug Fixes

* **workflows:** review against the intent a run froze, not the live Goal ([#960](https://github.com/teamupstart/mission-control/issues/960)) ([1665b76](https://github.com/teamupstart/mission-control/commit/1665b769ff768ca82a810683b68cf10ddac856f6))

## [1.11.0](https://github.com/teamupstart/mission-control/compare/v1.10.0...v1.11.0) (2026-09-09)


### Features

* **attachments:** preview an attached screenshot on double-click ([3ddc8d9](https://github.com/teamupstart/mission-control/commit/3ddc8d9a5e57279cafbfa45c8313b11254e39bc4))
* **conversation:** open a report in Files without arming comments ([625484c](https://github.com/teamupstart/mission-control/commit/625484ca53eab886d093226ae0152c463907a482))
* **dashboard:** recommended defaults, report View, and screenshot previews ([96adabd](https://github.com/teamupstart/mission-control/commit/96adabd59683078aa9a638a0c3f93a104ec320ba))
* **foreman:** ship the cheap tier on rather than in shadow ([f312a71](https://github.com/teamupstart/mission-control/commit/f312a71e896369009086b39e639b316403cc0e2f))
* **schedules:** let Foreman conclude a recurring mission's run ([#954](https://github.com/teamupstart/mission-control/issues/954)) ([ed2cc86](https://github.com/teamupstart/mission-control/commit/ed2cc86881f154be435895290415f5feaadfca51))
* **settings:** name the Agent SDK runtime as recommended ([a9e244c](https://github.com/teamupstart/mission-control/commit/a9e244c91ebb5b931a11fb36e93b01dfc55bb9ea))
* **tours:** continue the machine guide into Trust after Setup ([ff41098](https://github.com/teamupstart/mission-control/commit/ff41098650864e81a3668c8d1c479c1db0f08fc7))
* **tours:** continue the machine guide into Trust after Setup ([66418a0](https://github.com/teamupstart/mission-control/commit/66418a085dfde7d626dc91b99eff9e2e5b0ab4a2))
* **workflows:** allow Commands by default, behind the Trust grant ([b9e4865](https://github.com/teamupstart/mission-control/commit/b9e486524e1a7e34b41098e66aa0ebef6bab7943))


### Bug Fixes

* **e2e:** flush the Pi fake's response before it exits ([86ec300](https://github.com/teamupstart/mission-control/commit/86ec300a170946405ff6e0a9059c0c2cc59a9954))
* **models:** tell a signed-out harness how to sign in ([2fec302](https://github.com/teamupstart/mission-control/commit/2fec302ba39648d835bda2382f277a670d0b73bd))
* **models:** tell a signed-out harness how to sign in ([7138320](https://github.com/teamupstart/mission-control/commit/713832026e204c2344420366e712c4e1cb87d484))
* **setup:** derive both hook predicates from one list, name both repairs ([e5b7641](https://github.com/teamupstart/mission-control/commit/e5b76416b77d8d888ea430480278f38403c872ed))
* **setup:** forgive only the parse errors our own read bound caused ([203137d](https://github.com/teamupstart/mission-control/commit/203137d7cd74f7a29b88b10fc5fa97a09ca6e7d2))
* **setup:** refuse an unparseable settings file, settle the env fetch in the spec ([54a6678](https://github.com/teamupstart/mission-control/commit/54a6678e9d378f32452f7d8a5791b1388f77806d))
* **setup:** report a Claude hook path that no longer resolves ([22bd290](https://github.com/teamupstart/mission-control/commit/22bd290a6ba3c138fdbf317673d651a69d236af4))
* **setup:** report a Claude hook path that no longer resolves ([2e66ade](https://github.com/teamupstart/mission-control/commit/2e66ade9edc294f926cbcbe355e51f43cbb5f596))
* **setup:** stop Herdr enumeration logging, offer to start its server ([#955](https://github.com/teamupstart/mission-control/issues/955)) ([7393773](https://github.com/teamupstart/mission-control/commit/7393773fe96e0ec8dbae0404fa40c339b9dbb356))
* **tours:** name the Trust panels, not a column the matrix does not have ([73a05a2](https://github.com/teamupstart/mission-control/commit/73a05a2d49a80d4d204f39e3a23d5b6f010233d9))
* **workflows:** keep stored Command consent through an unrelated write ([6c488b3](https://github.com/teamupstart/mission-control/commit/6c488b3ed1978eba85117724abfbcd8ee165b4d3))
* **workflows:** model one run lifecycle state, and enforce it ([#952](https://github.com/teamupstart/mission-control/issues/952)) ([4659a4a](https://github.com/teamupstart/mission-control/commit/4659a4a2a3c9176d5f752bf8f12e1c2a07ba8a10))

## [1.10.0](https://github.com/teamupstart/mission-control/compare/v1.9.2...v1.10.0) (2026-09-08)


### Features

* **settings:** choose a terminal per harness ([#940](https://github.com/teamupstart/mission-control/issues/940)) ([df02731](https://github.com/teamupstart/mission-control/commit/df0273184445357b4c36c7a10bc5949888d50eaa))

## [1.9.2](https://github.com/teamupstart/mission-control/compare/v1.9.1...v1.9.2) (2026-09-07)


### Bug Fixes

* **conversation:** paginate with u and d ([#934](https://github.com/teamupstart/mission-control/issues/934)) ([84b7854](https://github.com/teamupstart/mission-control/commit/84b78546df4943882127452418f1f7408afaf09a))
* **desktop:** keep logo clear of window controls ([#935](https://github.com/teamupstart/mission-control/issues/935)) ([ed49e13](https://github.com/teamupstart/mission-control/commit/ed49e13522e0234fcdf5f8079b56ac563df8cf9a))
* **workflows:** reuse stable criteria across evidence refinements ([#937](https://github.com/teamupstart/mission-control/issues/937)) ([3ded53c](https://github.com/teamupstart/mission-control/commit/3ded53c1a5698cca798a4f4bedc68664be8ffa47))
* **workflows:** verify terminal pull request shipping ([#939](https://github.com/teamupstart/mission-control/issues/939)) ([f997316](https://github.com/teamupstart/mission-control/commit/f9973167c7b6811192c626fa84692ab9acbd9cf2))

## [1.9.1](https://github.com/teamupstart/mission-control/compare/v1.9.0...v1.9.1) (2026-09-07)


### Bug Fixes

* **git:** retry stale remote ref races ([#932](https://github.com/teamupstart/mission-control/issues/932)) ([45e816f](https://github.com/teamupstart/mission-control/commit/45e816f4e7579647500daa7e253d485fa004b592))

## [1.9.0](https://github.com/teamupstart/mission-control/compare/v1.8.0...v1.9.0) (2026-09-07)


### Features

* unify executable discovery and child-process environments ([#927](https://github.com/teamupstart/mission-control/issues/927)) ([e000aa6](https://github.com/teamupstart/mission-control/commit/e000aa6aa0f3d828accffe6633d6654c2426730c))
* **workflows:** draw one tile per round in the run scrubber ([#926](https://github.com/teamupstart/mission-control/issues/926)) ([57abd3f](https://github.com/teamupstart/mission-control/commit/57abd3f75db96bb15a63b25861c98aafae79a10a))


### Bug Fixes

* **docs:** retire the first-run chrome before a documentation capture ([#899](https://github.com/teamupstart/mission-control/issues/899)) ([071f9db](https://github.com/teamupstart/mission-control/commit/071f9db88c9ba7c8955e3fada038ee5c59edefca))
* **feedback:** publish product reports in one click ([#928](https://github.com/teamupstart/mission-control/issues/928)) ([6cc08dd](https://github.com/teamupstart/mission-control/commit/6cc08ddb23deb2166fa64d31bc8e14a9b626e7b7))
* **terminal:** make iTerm2 launches observable ([#929](https://github.com/teamupstart/mission-control/issues/929)) ([16535ab](https://github.com/teamupstart/mission-control/commit/16535ab1bea1b7108e6d9a908acb3a38e3a892ea))
* **workflows:** preserve delivery attribution across restarts ([#931](https://github.com/teamupstart/mission-control/issues/931)) ([3cc334a](https://github.com/teamupstart/mission-control/commit/3cc334a76c8cdeaf4d060cc2a094106c068be4f2))

## [1.8.0](https://github.com/teamupstart/mission-control/compare/v1.7.1...v1.8.0) (2026-09-06)


### Features

* **board:** print the jump keycap on the Console rail too ([#921](https://github.com/teamupstart/mission-control/issues/921)) ([f1cfd3b](https://github.com/teamupstart/mission-control/commit/f1cfd3b1960103af83354d232acc128c1a88df04))
* **board:** put a card's workflow details behind a Display setting ([#911](https://github.com/teamupstart/mission-control/issues/911)) ([2b1a4a9](https://github.com/teamupstart/mission-control/commit/2b1a4a92116bdc070a1dbbee9d2ac6dd41e9c620))
* **pipelines:** recover failed Engineer attempts ([#916](https://github.com/teamupstart/mission-control/issues/916)) ([5d90f2c](https://github.com/teamupstart/mission-control/commit/5d90f2ca8d0255e80d65177fd950a40ec1b9e79f))
* **setup:** warn when the GitHub CLI is older than 2.100.0 ([#913](https://github.com/teamupstart/mission-control/issues/913)) ([d08fe3f](https://github.com/teamupstart/mission-control/commit/d08fe3f89a613de6aaad16b7414b1424c65a3ed7))
* **terminal:** integrate stable Herdr multiplexer ([#919](https://github.com/teamupstart/mission-control/issues/919)) ([979ebde](https://github.com/teamupstart/mission-control/commit/979ebdee84cfa79dadd2ecd79e096653c780e059))
* **workflows:** measure evidence preflight outcomes ([#914](https://github.com/teamupstart/mission-control/issues/914)) ([346ea14](https://github.com/teamupstart/mission-control/commit/346ea149fe85f5f75b3eab04e570d4d2f63c0a3a))
* **workflows:** route Code Design reviews through Codex Sol ([#923](https://github.com/teamupstart/mission-control/issues/923)) ([9b278b6](https://github.com/teamupstart/mission-control/commit/9b278b61383ec712fde622fe8f39af058d28496d))


### Bug Fixes

* **codex:** read conversation prose from item_completed rollout records ([#915](https://github.com/teamupstart/mission-control/issues/915)) ([0a28c19](https://github.com/teamupstart/mission-control/commit/0a28c19102ad840885534451c25930a710b7bd06))
* make iTerm2 handoffs reliable ([#917](https://github.com/teamupstart/mission-control/issues/917)) ([9643f37](https://github.com/teamupstart/mission-control/commit/9643f37efdfd742931886f8ea5d59babbaf6a74d))
* **packaging:** disable implicit release publishing ([#909](https://github.com/teamupstart/mission-control/issues/909)) ([865c985](https://github.com/teamupstart/mission-control/commit/865c98570eb5a884886b58e737895aa87a1195b3))
* **sessions:** recover Claude SDK authentication ([#922](https://github.com/teamupstart/mission-control/issues/922)) ([0e82cb3](https://github.com/teamupstart/mission-control/commit/0e82cb3d8b2eefb6280edb727303b5b7a9f0981a))
* **tasks:** name generated titles after the work ([#920](https://github.com/teamupstart/mission-control/issues/920)) ([d44ca60](https://github.com/teamupstart/mission-control/commit/d44ca6007ea26150f7cd02fa275c6eaa8c9900f7))

## [1.7.1](https://github.com/teamupstart/mission-control/compare/v1.7.0...v1.7.1) (2026-09-05)


### Bug Fixes

* **deps:** resolve open security advisories ([#906](https://github.com/teamupstart/mission-control/issues/906)) ([1997994](https://github.com/teamupstart/mission-control/commit/19979948e9b4a4fb49880fa4a680cca1bb9fd127))

## [1.7.0](https://github.com/teamupstart/mission-control/compare/v1.6.0...v1.7.0) (2026-09-05)


### Features

* **board:** jump to a card's console with the number row ([#903](https://github.com/teamupstart/mission-control/issues/903)) ([319f5a6](https://github.com/teamupstart/mission-control/commit/319f5a65865169dad22267d3035fdfcc57be054c))
* **harness:** discover Codex models from the installed CLI ([#894](https://github.com/teamupstart/mission-control/issues/894)) ([c74978e](https://github.com/teamupstart/mission-control/commit/c74978e356a479ce99beb0420a33821d71184070))
* **pipelines:** consume provider lifecycle evidence ([#902](https://github.com/teamupstart/mission-control/issues/902)) ([677072a](https://github.com/teamupstart/mission-control/commit/677072a588a26fadff6bd31ff16aae6b2886b638))
* **terminal:** strengthen multiplexer correlation ([#907](https://github.com/teamupstart/mission-control/issues/907)) ([91ba884](https://github.com/teamupstart/mission-control/commit/91ba88457a6d2fd16f6cdc675b643b380d1e9ff8))
* **tours:** rework Set up this machine as the first-run tour ([#896](https://github.com/teamupstart/mission-control/issues/896)) ([24a361c](https://github.com/teamupstart/mission-control/commit/24a361cd72f718e5d68ea0d5a79351b35f34196c))
* **updates:** build the update while the app stays open ([#900](https://github.com/teamupstart/mission-control/issues/900)) ([8c09369](https://github.com/teamupstart/mission-control/commit/8c09369f9175a1b796dc77af2900d1dc413105d6))
* **workflows:** enforce criterion-mapped evidence preflight ([#893](https://github.com/teamupstart/mission-control/issues/893)) ([36d33b6](https://github.com/teamupstart/mission-control/commit/36d33b63605c27da08ba918dd8b98ab7c2c994a3))


### Bug Fixes

* **jira:** accept structured Claude tool results ([#904](https://github.com/teamupstart/mission-control/issues/904)) ([9a592b3](https://github.com/teamupstart/mission-control/commit/9a592b32ff2fe851754c28e729111d7588740525))
* **runtime:** resolve version-manager shim paths ([#901](https://github.com/teamupstart/mission-control/issues/901)) ([5cad888](https://github.com/teamupstart/mission-control/commit/5cad8887fd4c013be31bc1d158bd13a807d43329))
* **workflows:** bypass command queue for spent checks ([#897](https://github.com/teamupstart/mission-control/issues/897)) ([10f0505](https://github.com/teamupstart/mission-control/commit/10f0505d09dc049ce0056f642fcb285ef45ae259))
* **workflows:** read legacy command evidence ([#895](https://github.com/teamupstart/mission-control/issues/895)) ([41c2cd6](https://github.com/teamupstart/mission-control/commit/41c2cd6985cd7f2ba8d1941ef7b1847bed6b38e5))

## [1.6.0](https://github.com/teamupstart/mission-control/compare/v1.5.0...v1.6.0) (2026-09-04)


### Features

* **board:** show workflow stage progress on session cards ([#884](https://github.com/teamupstart/mission-control/issues/884)) ([79030c9](https://github.com/teamupstart/mission-control/commit/79030c957dfaf421908cca99c616d7865b71de64))
* **conversation:** preview HTML artifacts inline ([#879](https://github.com/teamupstart/mission-control/issues/879)) ([84e09d9](https://github.com/teamupstart/mission-control/commit/84e09d9a7050aae906956576b98d5d17a51d00e0))
* **pipelines:** preserve workspace evidence ([#872](https://github.com/teamupstart/mission-control/issues/872)) ([87fd495](https://github.com/teamupstart/mission-control/commit/87fd49585c2a706ccc6c03eaa6a3ef622e231850))
* **pipelines:** unify feature reader across handoff ([#885](https://github.com/teamupstart/mission-control/issues/885)) ([d86a442](https://github.com/teamupstart/mission-control/commit/d86a442d76e9b0531022048c8253a63d532aebc5))
* **terminals:** add first-class iTerm2 support ([#888](https://github.com/teamupstart/mission-control/issues/888)) ([4ff52da](https://github.com/teamupstart/mission-control/commit/4ff52da3dacbdd4b3d97bbb3811a3f7c7760c8e1))
* **workflows:** add criterion-mapped evidence readiness ([#887](https://github.com/teamupstart/mission-control/issues/887)) ([7517cac](https://github.com/teamupstart/mission-control/commit/7517caccd3b2c892ade8a492019a7118b6ee40e3))
* **workflows:** add Slop Filter to No-Mistakes Review ([#883](https://github.com/teamupstart/mission-control/issues/883)) ([a290aa3](https://github.com/teamupstart/mission-control/commit/a290aa33de41775165dbce97821239e0e206bf2b))


### Bug Fixes

* **conversation:** collapse the header instead of wrapping it ([#890](https://github.com/teamupstart/mission-control/issues/890)) ([3ac305d](https://github.com/teamupstart/mission-control/commit/3ac305d63aab3c8385b9cf27ff7d561bc0a1365e))
* **jira:** support approved MCP registrations ([#881](https://github.com/teamupstart/mission-control/issues/881)) ([ddb899d](https://github.com/teamupstart/mission-control/commit/ddb899d1b6c57bd8a6aa467699b22f37dce916b6))

## [1.5.0](https://github.com/teamupstart/mission-control/compare/v1.4.0...v1.5.0) (2026-09-04)


### Features

* **fleet:** search sessions by pull request number ([#877](https://github.com/teamupstart/mission-control/issues/877)) ([269a0c8](https://github.com/teamupstart/mission-control/commit/269a0c83ca49cc027f49e5689501b561322773e1))
* **setup:** read machine setup one family at a time ([#864](https://github.com/teamupstart/mission-control/issues/864)) ([b5bb1cd](https://github.com/teamupstart/mission-control/commit/b5bb1cdcc71402991963852bfb8f6ed3448a18a9))
* **workflows:** review code design in No-Mistakes Review ([#868](https://github.com/teamupstart/mission-control/issues/868)) ([14c59dc](https://github.com/teamupstart/mission-control/commit/14c59dc444eeace9961da6c75cd551a28bc726c5))


### Bug Fixes

* **ensembles:** judge Best-of-N artifacts only ([#871](https://github.com/teamupstart/mission-control/issues/871)) ([a4b0916](https://github.com/teamupstart/mission-control/commit/a4b0916aed01c49d49abbefcb434effbfd915c0d))
* **pi:** discover models through login-shell PATH ([#869](https://github.com/teamupstart/mission-control/issues/869)) ([5579590](https://github.com/teamupstart/mission-control/commit/55795900d84d6111bdf722a353e0d9b19151b47e))
* **reports:** require dark-scheme contrast checks so new reports stay readable ([#866](https://github.com/teamupstart/mission-control/issues/866)) ([892b8a7](https://github.com/teamupstart/mission-control/commit/892b8a71421f738deb493de22d5977bbaee0d2b6))
* **scouts:** bound the prompt ledger instead of each prompt body ([#874](https://github.com/teamupstart/mission-control/issues/874)) ([486c85d](https://github.com/teamupstart/mission-control/commit/486c85d1cfceacfee4277838bc78077f3cc88fb8))
* **sessions:** resolve agent binary before terminal handoff ([#878](https://github.com/teamupstart/mission-control/issues/878)) ([c07f723](https://github.com/teamupstart/mission-control/commit/c07f7234dbb436655e5ea2ef8c9212e4f30a3e0b))
* **web:** give every modal its content inset from the shell ([#876](https://github.com/teamupstart/mission-control/issues/876)) ([4b6467e](https://github.com/teamupstart/mission-control/commit/4b6467e4bf45c73dd295554fb77248594fe9c622))

## [1.4.0](https://github.com/teamupstart/mission-control/compare/v1.3.4...v1.4.0) (2026-09-03)


### Features

* **product-issues:** attach images with GitHub CLI ([#862](https://github.com/teamupstart/mission-control/issues/862)) ([ee03032](https://github.com/teamupstart/mission-control/commit/ee03032f7e0f6d682483cba4370e0a4430ad3ba1))


### Bug Fixes

* **updater:** stop auto-upgrade demanding authorization it never needed ([#858](https://github.com/teamupstart/mission-control/issues/858)) ([48e0473](https://github.com/teamupstart/mission-control/commit/48e0473b7cecf9e9a741fff36243717261cee62c))

## [1.3.4](https://github.com/teamupstart/mission-control/compare/v1.3.3...v1.3.4) (2026-09-01)


### Bug Fixes

* **files:** show readable HTML comment quotes ([#856](https://github.com/teamupstart/mission-control/issues/856)) ([e290e78](https://github.com/teamupstart/mission-control/commit/e290e78080f1c56da3f189307158fa060c39ade0))
* **pipelines:** show recoverable Engineer blockers ([#854](https://github.com/teamupstart/mission-control/issues/854)) ([745ff51](https://github.com/teamupstart/mission-control/commit/745ff519373387aee6e87f449d74e24ea06148f1))
* **web:** keep Dispatch responsive with comments open ([#857](https://github.com/teamupstart/mission-control/issues/857)) ([66ffb30](https://github.com/teamupstart/mission-control/commit/66ffb30a956f765ae6e0fa508ab2eececc84fd88))

## [1.3.3](https://github.com/teamupstart/mission-control/compare/v1.3.2...v1.3.3) (2026-08-31)


### Bug Fixes

* **foreman:** protect active session composers ([#848](https://github.com/teamupstart/mission-control/issues/848)) ([00c2aa9](https://github.com/teamupstart/mission-control/commit/00c2aa9963617a1c53ed381d8d3376f08dfc57d1))
* **pipelines:** detect stale conductor bundles ([#851](https://github.com/teamupstart/mission-control/issues/851)) ([f9a5009](https://github.com/teamupstart/mission-control/commit/f9a500978b6e48023bfe61394c0302d820ee370b))
* **updater:** clarify authorization and preserve CLI PATH ([#850](https://github.com/teamupstart/mission-control/issues/850)) ([2e6c2a3](https://github.com/teamupstart/mission-control/commit/2e6c2a3916cf127f03a50c693902e26ff48bb538))

## [1.3.2](https://github.com/teamupstart/mission-control/compare/v1.3.1...v1.3.2) (2026-08-31)


### Bug Fixes

* **release:** reject unparseable release commits ([#846](https://github.com/teamupstart/mission-control/issues/846)) ([1e5bd3c](https://github.com/teamupstart/mission-control/commit/1e5bd3cd37bfaf4d7711552c982177b08cb7fb74))

## [1.3.1](https://github.com/teamupstart/mission-control/compare/v1.3.0...v1.3.1) (2026-08-30)


### Bug Fixes

* make app auto-upgrades privilege-safe ([#843](https://github.com/teamupstart/mission-control/issues/843)) ([11e7fd8](https://github.com/teamupstart/mission-control/commit/11e7fd8c54852a043a46f8c443dc8c0d4a0dabea))

## [1.3.0](https://github.com/teamupstart/mission-control/compare/v1.2.0...v1.3.0) (2026-08-30)


### Features

* add verified automatic database backups ([#839](https://github.com/teamupstart/mission-control/issues/839)) ([3125aaa](https://github.com/teamupstart/mission-control/commit/3125aaa82401e3ad572cce01ce7871626682db6e))


### Bug Fixes

* **settings:** verify trust snapshot coverage ([#829](https://github.com/teamupstart/mission-control/issues/829)) ([9bcfc96](https://github.com/teamupstart/mission-control/commit/9bcfc965302b9346f99c6307eaaedc2a6ec89cc6))
* **setup:** detect login-shell agent binaries ([#828](https://github.com/teamupstart/mission-control/issues/828)) ([6d85d0b](https://github.com/teamupstart/mission-control/commit/6d85d0b4566d037ffaecb7643ec3f3c13ae4fb77))
* **worktrees:** recover quarantined cleanup and speed inventory ([#832](https://github.com/teamupstart/mission-control/issues/832)) ([6b7fb8d](https://github.com/teamupstart/mission-control/commit/6b7fb8df2e81437b263985f9abbad22731cbb83b))

## [1.2.0](https://github.com/teamupstart/mission-control/compare/v1.1.0...v1.2.0) (2026-08-28)


### Features

* **board:** restyle the repository group as a quiet box with a coloured bracket ([#821](https://github.com/teamupstart/mission-control/issues/821)) ([bc13e2a](https://github.com/teamupstart/mission-control/commit/bc13e2ae8384205d7ddeda3a4972fa16c15f2d25))
* **files:** find in a document with Cmd+F, in Preview and in the Editor ([#824](https://github.com/teamupstart/mission-control/issues/824)) ([4eeab1e](https://github.com/teamupstart/mission-control/commit/4eeab1eee4abb4a4fcc0f7af7cd0479ccaf37bca))
* **files:** find inside the HTML preview, marking only what a reader can see ([#827](https://github.com/teamupstart/mission-control/issues/827)) ([df1758e](https://github.com/teamupstart/mission-control/commit/df1758ed2f1bc8873dac68edcc7ef55ad33839c0))
* **instructions:** repository standing instructions, store and delivery ([#751](https://github.com/teamupstart/mission-control/issues/751)) ([c76b18b](https://github.com/teamupstart/mission-control/commit/c76b18bd899a4c898bab80dc2b90ecd4afcacf42))
* **instructions:** Standing instructions settings panel ([#761](https://github.com/teamupstart/mission-control/issues/761)) ([9679213](https://github.com/teamupstart/mission-control/commit/9679213f37d532d3757cba709b78b2153e725677))
* **line:** fold the pipeline strip to one row, condensed by default ([#809](https://github.com/teamupstart/mission-control/issues/809)) ([655f71e](https://github.com/teamupstart/mission-control/commit/655f71e165ea025f23e72d2d5f9ac01f5eacdaae))
* **pipelines:** support refused steps and plan gaps ([#811](https://github.com/teamupstart/mission-control/issues/811)) ([844c810](https://github.com/teamupstart/mission-control/commit/844c810645854366762c7ac9eb65ffcc52dc9e2e))


### Bug Fixes

* bump 25 vulnerable dependencies [@hono/node-server, nanoid, next, postcss, sharp] ([#826](https://github.com/teamupstart/mission-control/issues/826)) ([eb4e43e](https://github.com/teamupstart/mission-control/commit/eb4e43e10dc8227ba9dac50fa8fb18d8f29c419a))
* **diff:** focus keyboard navigation after tabbing ([#822](https://github.com/teamupstart/mission-control/issues/822)) ([36cc4c2](https://github.com/teamupstart/mission-control/commit/36cc4c212c79783eb93f2ee04461dc224fec18b7))
* **files:** let the comment composer take keystrokes in a dev build ([#797](https://github.com/teamupstart/mission-control/issues/797)) ([84ac0f5](https://github.com/teamupstart/mission-control/commit/84ac0f593aa8836ff312c0be1fc6420404817fb8))
* make every review prompt dismissible ([#781](https://github.com/teamupstart/mission-control/issues/781)) ([340b571](https://github.com/teamupstart/mission-control/commit/340b571c159f4e60ef025dfa7829948950d4b0da))
* **scouts:** bound and collapse the archived prompt ledger ([#794](https://github.com/teamupstart/mission-control/issues/794)) ([844dde5](https://github.com/teamupstart/mission-control/commit/844dde5cf768a99d545e6773300621fd54768841))
* track Pipeline authoring worktrees ([#819](https://github.com/teamupstart/mission-control/issues/819)) ([b607f0d](https://github.com/teamupstart/mission-control/commit/b607f0d41f0be807f8f6e93657ab2d81798b70ee))
* **updater:** migrate canonical repository URL ([#793](https://github.com/teamupstart/mission-control/issues/793)) ([b9c1481](https://github.com/teamupstart/mission-control/commit/b9c14813bbf8b7cbdd34138251880989a0a63785))
* **workflows:** accept agent evidence from a manually bound conversation ([#804](https://github.com/teamupstart/mission-control/issues/804)) ([b4a5fbc](https://github.com/teamupstart/mission-control/commit/b4a5fbc4a3e8a555e9bfc8005a4994e9fc516d70))


### Performance Improvements

* **test:** default local suite to six workers ([#742](https://github.com/teamupstart/mission-control/issues/742)) ([7cc52bd](https://github.com/teamupstart/mission-control/commit/7cc52bdef0cc516879a7907790bfd28d67880647))

## [1.1.0](https://github.com/mancej-cyc/ai-harness/compare/v1.0.1...v1.1.0) (2026-08-22)


### Features

* **workflows:** cap how often a Command runs per workflow run ([#739](https://github.com/mancej-cyc/ai-harness/issues/739)) ([3add02a](https://github.com/mancej-cyc/ai-harness/commit/3add02a9d32b6d392c9ab0a1ee3ffbcdbadad4b0))


### Bug Fixes

* recognize a dispatched launch coming back through the prompt hook ([#734](https://github.com/mancej-cyc/ai-harness/issues/734)) ([f9ec06a](https://github.com/mancej-cyc/ai-harness/commit/f9ec06ae4210c63f3fd9c5b128f522b3c7512a70))

## [1.0.1](https://github.com/mancej-cyc/ai-harness/compare/v1.0.0...v1.0.1) (2026-08-22)


### Bug Fixes

* **release:** unpin release-as so releases after v1.0.0 can be cut ([#732](https://github.com/mancej-cyc/ai-harness/issues/732)) ([e4eefe5](https://github.com/mancej-cyc/ai-harness/commit/e4eefe532c7a823a61ef654a67b812bb0908e570))

## [1.0.0](https://github.com/mancej-cyc/ai-harness/compare/v0.1.0...v1.0.0) (2026-08-22)


### Features

* add direct fleet and runs shortcuts ([#396](https://github.com/mancej-cyc/ai-harness/issues/396)) ([dcbd691](https://github.com/mancej-cyc/ai-harness/commit/dcbd691840075203a9b222e729b1ef3de52316d2))
* add editable queued conversation turns ([#364](https://github.com/mancej-cyc/ai-harness/issues/364)) ([bc658d6](https://github.com/mancej-cyc/ai-harness/commit/bc658d6ad2d41fd1cbcfa91702dc7a7661213a81))
* **board:** split the idle column into free and held-by-workflow rows ([#433](https://github.com/mancej-cyc/ai-harness/issues/433)) ([f2ed318](https://github.com/mancej-cyc/ai-harness/commit/f2ed318e60555d7c15a834db80cafe48a8a73b7f))
* **board:** toggle workflow details with e ([#382](https://github.com/mancej-cyc/ai-harness/issues/382)) ([8daa31e](https://github.com/mancej-cyc/ai-harness/commit/8daa31eadcdadc7f9fe6e2abb77823b0d0735868))
* **console:** move workflow and gate progress into a Workflows tab ([#351](https://github.com/mancej-cyc/ai-harness/issues/351)) ([e255c39](https://github.com/mancej-cyc/ai-harness/commit/e255c39df6d18847151b88b6cb722ce04882e3e0))
* **console:** pin the conversation clock to the right of each byline ([#355](https://github.com/mancej-cyc/ai-harness/issues/355)) ([2487bde](https://github.com/mancej-cyc/ai-harness/commit/2487bded928f42aa3d47e7982a5998277238fc23))
* **conversation:** show your review answers in the session timeline ([#358](https://github.com/mancej-cyc/ai-harness/issues/358)) ([818c5c9](https://github.com/mancej-cyc/ai-harness/commit/818c5c97d027c3eebcd2034b4ecf5444707096ed))
* **demo:** a fleet that demonstrates the product rather than describing it ([abbc967](https://github.com/mancej-cyc/ai-harness/commit/abbc96751124c73c327dc11c398c3c8a5af05c4f))
* **demo:** a fleet that demonstrates the product rather than describing it ([4bacc38](https://github.com/mancej-cyc/ai-harness/commit/4bacc380678be7ae6d0eb1a41b713c4b62d631a1))
* **demo:** add npm run demo - token-free scenario-player demo mode ([ce5dbc5](https://github.com/mancej-cyc/ai-harness/commit/ce5dbc53bbf5228eddb49636496f19e1e145c4e2))
* **demo:** give pi a real scenario player instead of a stub ([71866b1](https://github.com/mancej-cyc/ai-harness/commit/71866b1c443eeccd5a949e2f923d34410034b93c))
* **demo:** seed a lived-in fleet so --fresh opens at the interesting part ([7f80ed7](https://github.com/mancej-cyc/ai-harness/commit/7f80ed746affa66cc49928357ced1801afb7feb9))
* **demo:** seed a lived-in fleet so `npm run demo -- --fresh` opens at the interesting part ([8d5f012](https://github.com/mancej-cyc/ai-harness/commit/8d5f012ff95dcc144da8358c3a901107bc3365e9))
* **diff:** add Open in Files shortcut ([#547](https://github.com/mancej-cyc/ai-harness/issues/547)) ([6efb742](https://github.com/mancej-cyc/ai-harness/commit/6efb742186d8357e8e5e92cda36e9d06eb20fa15))
* **dispatch:** create a GitHub issue from a backlog task (phase 3) ([#474](https://github.com/mancej-cyc/ai-harness/issues/474)) ([f201fd2](https://github.com/mancej-cyc/ai-harness/commit/f201fd268591859e66eaa69066aa54e30d8214cf))
* **dispatch:** delete a backlog task from its own editor ([#463](https://github.com/mancej-cyc/ai-harness/issues/463)) ([2d19796](https://github.com/mancej-cyc/ai-harness/commit/2d197964caa2958bd6caf92e7315c3d88cd31093))
* **dispatch:** scout defaults the after-work Workflow to None ([#369](https://github.com/mancej-cyc/ai-harness/issues/369)) ([a2f8f45](https://github.com/mancej-cyc/ai-harness/commit/a2f8f4525c49613ea2a76c08ed76ccdefa2e89cf))
* **dispatch:** warn when the machine's UpstartClaw setup is incomplete ([8ca62ad](https://github.com/mancej-cyc/ai-harness/commit/8ca62adbd6e64e0784a5c97bb17c4b859e9c9351))
* **fleet:** tell the operator how to refresh from the empty fleet screen ([#341](https://github.com/mancej-cyc/ai-harness/issues/341)) ([cf505dd](https://github.com/mancej-cyc/ai-harness/commit/cf505dd32968540f027bbd73b1ae636512f588f0))
* **foreman:** durable per-session Foreman invite model (phase 1) ([#458](https://github.com/mancej-cyc/ai-harness/issues/458)) ([9e75e47](https://github.com/mancej-cyc/ai-harness/commit/9e75e4718461c9c6957cfbe89c2a935f1835fae1))
* **foreman:** gate every Foreman action on a session invite (phase 2) ([#470](https://github.com/mancej-cyc/ai-harness/issues/470)) ([21c3cd8](https://github.com/mancej-cyc/ai-harness/commit/21c3cd8e0712f7427ca1c6b82390e42e379d5e2a))
* **foreman:** reconcile durable session objectives ([#357](https://github.com/mancej-cyc/ai-harness/issues/357)) ([1c29a95](https://github.com/mancej-cyc/ai-harness/commit/1c29a9559c9210d975f3b396cf04905c6c7ee982))
* **foreman:** show and control session participation from the rail (phase 3) ([#473](https://github.com/mancej-cyc/ai-harness/issues/473)) ([6afcdbc](https://github.com/mancej-cyc/ai-harness/commit/6afcdbc524d09b90336d4cac1d4b5c34ad2064ca))
* guide verified Conductor installation ([#634](https://github.com/mancej-cyc/ai-harness/issues/634)) ([1236b13](https://github.com/mancej-cyc/ai-harness/commit/1236b131280875c2d3f012a53e19d6dcc94d046f))
* **inspector:** carry PR titles on the adoption ledger and read it by adoption window ([#402](https://github.com/mancej-cyc/ai-harness/issues/402)) ([c461fce](https://github.com/mancej-cyc/ai-harness/commit/c461fce11bf390731cb35210867535b78a83d1b3))
* install command and release identity for the macOS app ([#653](https://github.com/mancej-cyc/ai-harness/issues/653)) ([19612a0](https://github.com/mancej-cyc/ai-harness/commit/19612a058716cf4c906f770aaa5bd6c4f1eaa71d))
* **library:** give Mission Control a Library at #/library ([#378](https://github.com/mancej-cyc/ai-harness/issues/378)) ([3657e69](https://github.com/mancej-cyc/ai-harness/commit/3657e697651d0fc923fc9c82c3429939f4ec6bc9))
* **line:** fold the Review drawer's identical rows, and split the strip's count ([#405](https://github.com/mancej-cyc/ai-harness/issues/405)) ([802aa21](https://github.com/mancej-cyc/ai-harness/commit/802aa21414955a0af60b58676dc397eff124f45a))
* **line:** give BACKLOG its own queue drawer, instead of the Sitrep ([#410](https://github.com/mancej-cyc/ai-harness/issues/410)) ([0a49e6b](https://github.com/mancej-cyc/ai-harness/commit/0a49e6b7f5d6bbd3858806ef94f960ad8691fb50))
* **line:** make the Backlog drawer explain itself ([#411](https://github.com/mancej-cyc/ai-harness/issues/411)) ([2a421ea](https://github.com/mancej-cyc/ai-harness/commit/2a421ea05e000324d24d2951b70000acbd27e056))
* **line:** name a stopped Review row, say why it stopped, offer its one remedy ([#403](https://github.com/mancej-cyc/ai-harness/issues/403)) ([2024f36](https://github.com/mancej-cyc/ai-harness/commit/2024f36e7a9ee55b15f32cfda1156f80604f0a46))
* **line:** open the adoption ledger from Shipped, and stop routing to runs ([#407](https://github.com/mancej-cyc/ai-harness/issues/407)) ([e9e17cf](https://github.com/mancej-cyc/ai-harness/commit/e9e17cf58e524dfba760d3812c2e0954b1b27660))
* **memory:** load a repo's committed .agents/memory index (phase 1) ([#471](https://github.com/mancej-cyc/ai-harness/issues/471)) ([3c3364d](https://github.com/mancej-cyc/ai-harness/commit/3c3364dcb61e613981e62ec75de02fe97b25a815))
* **palette:** turn ⌘K into the app-wide palette over the Library, the Line and settings ([#387](https://github.com/mancej-cyc/ai-harness/issues/387)) ([8da057d](https://github.com/mancej-cyc/ai-harness/commit/8da057d24169408d80e65c0960b33477ed47fe1d))
* **personas:** import a Markdown role by path, with provenance and drift detection ([#448](https://github.com/mancej-cyc/ai-harness/issues/448)) ([344cdaf](https://github.com/mancej-cyc/ai-harness/commit/344cdaf40d30d6c667b84c9f3887755e8c0a2b60))
* **phased-plan:** publish goal-level task text, not the phase plan ([#354](https://github.com/mancej-cyc/ai-harness/issues/354)) ([c694515](https://github.com/mancej-cyc/ai-harness/commit/c69451501ebfbaf1b592c98855f8955e3e20880b))
* **retro:** make the retro executable end to end without UI (phase 2) ([#476](https://github.com/mancej-cyc/ai-harness/issues/476)) ([2c07af6](https://github.com/mancej-cyc/ai-harness/commit/2c07af65de28e6d7dff8a5c63e6674a80d9f2ac5))
* **retro:** offer the retro at the moment the plan chose (phase 3) ([#481](https://github.com/mancej-cyc/ai-harness/issues/481)) ([fedff26](https://github.com/mancej-cyc/ai-harness/commit/fedff2698c277cb804f0c0b4acf19310b0d04ee3))
* **settings:** one paged, bounded table for every settings ledger ([45521e0](https://github.com/mancej-cyc/ai-harness/commit/45521e0236d0d679013693a79b8224b6f7f8467a))
* **settings:** one paged, bounded table for every settings ledger ([4844da0](https://github.com/mancej-cyc/ai-harness/commit/4844da03dad75d4536309249484d8e9946a00e56))
* **shipped:** give the adoption ledger a cross-repo Ship log page ([#406](https://github.com/mancej-cyc/ai-harness/issues/406)) ([37e3a57](https://github.com/mancej-cyc/ai-harness/commit/37e3a570eaba6ccddf66bc082b0ee116a2c4a4f8))
* show timestamps in conversations ([#349](https://github.com/mancej-cyc/ai-harness/issues/349)) ([50eeae9](https://github.com/mancej-cyc/ai-harness/commit/50eeae946ccf2e4ed9e75f645901e77ca71272a5))
* surface desktop updates in the dashboard ([#671](https://github.com/mancej-cyc/ai-harness/issues/671)) ([2670b45](https://github.com/mancej-cyc/ai-harness/commit/2670b4593aab624a1d200b864348a98b774df52f))
* **task-sources:** push a backlog task to a source, over one route (phase 2) ([#469](https://github.com/mancej-cyc/ai-harness/issues/469)) ([84a242e](https://github.com/mancej-cyc/ai-harness/commit/84a242e70731648b15a3572a194d01b296f05f3c))
* **task-sources:** push capability at the contract level, and one gh seam ([#465](https://github.com/mancej-cyc/ai-harness/issues/465)) ([e550fda](https://github.com/mancej-cyc/ai-harness/commit/e550fda8f2b33b829d085666a503cca481846ee5))
* **task-sources:** sweep a Jira JQL filter into the backlog ([#443](https://github.com/mancej-cyc/ai-harness/issues/443)) ([943f288](https://github.com/mancej-cyc/ai-harness/commit/943f288d0ea8c1680076228d17154423510dd36d))
* **tasks:** add plan as a third task Kind ([#548](https://github.com/mancej-cyc/ai-harness/issues/548)) ([6edb348](https://github.com/mancej-cyc/ai-harness/commit/6edb348b28922ff4d4e8077cae982d955f7dae52))
* track Foreman and Inspector spend by role ([#348](https://github.com/mancej-cyc/ai-harness/issues/348)) ([7d6b97e](https://github.com/mancej-cyc/ai-harness/commit/7d6b97e23f9ada386bc10ad7c73c3a7e3f9914ef))
* **trust:** make the Workflows grant a Trust column ([#413](https://github.com/mancej-cyc/ai-harness/issues/413)) ([efc7aaf](https://github.com/mancej-cyc/ai-harness/commit/efc7aafe7801dfdef99a1945e5367a29a7c57d4e))
* use native macOS keep-awake assertion ([#665](https://github.com/mancej-cyc/ai-harness/issues/665)) ([50dc6ed](https://github.com/mancej-cyc/ai-harness/commit/50dc6eda88ef575e08daf0420898969d2492d050))
* **workflows:** author and watch session actions (session-action phase 3) ([#361](https://github.com/mancej-cyc/ai-harness/issues/361)) ([e02c58e](https://github.com/mancej-cyc/ai-harness/commit/e02c58ea1b5c5bf14d17355702e269b41522a177))
* **workflows:** durable SessionAction execution and evidence continuations (session-action phase 2) ([#360](https://github.com/mancej-cyc/ai-harness/issues/360)) ([54b99ab](https://github.com/mancej-cyc/ai-harness/commit/54b99abad380838a633a4d0f4eaa648abe349a36))
* **workflows:** gated process supervisor for Workflow checks (check-execution-runtime phase 3) ([#344](https://github.com/mancej-cyc/ai-harness/issues/344)) ([3169c19](https://github.com/mancej-cyc/ai-harness/commit/3169c1961dcaa550749b22c371ef8c064ecc15fc))
* **workflows:** let a finished run be run again ([#452](https://github.com/mancej-cyc/ai-harness/issues/452)) ([84db210](https://github.com/mancej-cyc/ai-harness/commit/84db210a9c9744ecf49b12153eb88e93cca2cda2))
* **workflows:** move the run's audit trio out of the header ([#442](https://github.com/mancej-cyc/ai-harness/issues/442)) ([3330abc](https://github.com/mancej-cyc/ai-harness/commit/3330abc4f1603c4272875d7f615d66ea2878cb94))
* **workflows:** per-run disable toggle for judges, checks, and stages ([#356](https://github.com/mancej-cyc/ai-harness/issues/356)) ([93bbc52](https://github.com/mancej-cyc/ai-harness/commit/93bbc521830111a69f1ec7dcc1a9129d625e4dd7))
* **workflows:** run Workflow check commands for real (check-execution-runtime phase 4) ([#352](https://github.com/mancej-cyc/ai-harness/issues/352)) ([f6786e6](https://github.com/mancej-cyc/ai-harness/commit/f6786e6bf250895ae70548262b9e5fcf04f7c167))
* **workflows:** say a stage was not re-run, and where it passed ([#543](https://github.com/mancej-cyc/ai-harness/issues/543)) ([8122179](https://github.com/mancej-cyc/ai-harness/commit/8122179affa9f62614ae3c9262fad0337148b429))
* **workflows:** SessionAction catalog, snapshots, and graph foundation ([#359](https://github.com/mancej-cyc/ai-harness/issues/359)) ([b91f159](https://github.com/mancej-cyc/ai-harness/commit/b91f15913710b54e70f30c6d6f3045800c5a185f))
* **workflows:** verified Pull Request action and No-Mistakes Review v8 ([#366](https://github.com/mancej-cyc/ai-harness/issues/366)) ([50c0bd1](https://github.com/mancej-cyc/ai-harness/commit/50c0bd195ab92c9eb21539102ab3df7a5feb2bb6))


### Bug Fixes

* **claude:** report a mid-turn send as steered, not queued ([#379](https://github.com/mancej-cyc/ai-harness/issues/379)) ([603a13b](https://github.com/mancej-cyc/ai-harness/commit/603a13b1f1df7a9f12418ddb31fc4dc88e089797))
* **codex:** fold a run of executed commands like Claude's ([#490](https://github.com/mancej-cyc/ai-harness/issues/490)) ([c9ba0e8](https://github.com/mancej-cyc/ai-harness/commit/c9ba0e83ca31562151690da9648c46978577257b))
* **codex:** release queued SDK messages after final answers ([#401](https://github.com/mancej-cyc/ai-harness/issues/401)) ([2d66c3f](https://github.com/mancej-cyc/ai-harness/commit/2d66c3f9f409afbc2161873244d7aab2e3573ebf))
* **codex:** route discrete choices through Mission Control ([#675](https://github.com/mancej-cyc/ai-harness/issues/675)) ([b8bdb6d](https://github.com/mancej-cyc/ai-harness/commit/b8bdb6dfaede7931a60679ae5f062ea5c10b0c3b))
* correct a stale contract reference and drop unrelated test churn ([c76dd8f](https://github.com/mancej-cyc/ai-harness/commit/c76dd8f4fc9126cb8a6893e34cdc521c1d969767))
* **cost:** expire driver ownership so a resumed session is counted again ([f1c7bd9](https://github.com/mancej-cyc/ai-harness/commit/f1c7bd9ce9c7d362d760988204262524fe0781e3))
* **cost:** grace-period the exporter warning after enabling telemetry ([6a834fd](https://github.com/mancej-cyc/ai-harness/commit/6a834fdbc3767f2232a059bd92dcff211901f4cd))
* **cost:** judge the exporter on arrival, not on rows it left behind ([47d05c3](https://github.com/mancej-cyc/ai-harness/commit/47d05c39013ef8af8556e6523e072151af38f4c6))
* **cost:** record Claude session spend from the driver, not only OTel ([1f0ce34](https://github.com/mancej-cyc/ai-harness/commit/1f0ce34a7c1912ea5a3fda010a814ef00df73ab5))
* **cost:** record Claude session spend from the driver, not only OTel ([6d35de5](https://github.com/mancej-cyc/ai-harness/commit/6d35de5c9a9c86ab1601eb3d8ab5f12552eef329))
* **cost:** scope the exporter warning's activity half to Claude ([9eeb1dd](https://github.com/mancej-cyc/ai-harness/commit/9eeb1dd2992810c7fe015ef22610525be53efcc0))
* **demo:** stop the daemon on every Foreman startup/shutdown path ([f59b0a3](https://github.com/mancej-cyc/ai-harness/commit/f59b0a389275acc07aa578266f0c1a54e0c7b442))
* **demo:** stop the seeder's daemon on a signal, not just on its own exit paths ([5d1bf00](https://github.com/mancej-cyc/ai-harness/commit/5d1bf0005fcb235698c5a912c1072a33925dcce9))
* **discovery:** prevent duplicate cards for embedded sessions ([#347](https://github.com/mancej-cyc/ai-harness/issues/347)) ([52c8fb2](https://github.com/mancej-cyc/ai-harness/commit/52c8fb2f7aa0f1bd3927d04ef8fb82e12c7b8669))
* **dispatch:** attach window drops during guided setup ([#533](https://github.com/mancej-cyc/ai-harness/issues/533)) ([f20a6e7](https://github.com/mancej-cyc/ai-harness/commit/f20a6e75991be54c9047b28c9d6b9c2d8c4163f7))
* **dispatch:** refuse a launch whose MCP bundle lacks a required tool ([#537](https://github.com/mancej-cyc/ai-harness/issues/537)) ([09939cb](https://github.com/mancej-cyc/ai-harness/commit/09939cbc1f2a9207783e94af8c761fdb22d3493b))
* **dispatch:** report a failed environment read as nothing, explicitly ([5cb098e](https://github.com/mancej-cyc/ai-harness/commit/5cb098ed38e6f1ac2a0b35da3ccf5018c07ff1cf))
* **dispatch:** stop reporting a killed git check as a broken repository ([#408](https://github.com/mancej-cyc/ai-harness/issues/408)) ([5d6d39d](https://github.com/mancej-cyc/ai-harness/commit/5d6d39de21c8724b46cfa02fc73d63097d176733))
* **environment:** classify an unrecognised setup file instead of quoting it ([d2ecdd2](https://github.com/mancej-cyc/ai-harness/commit/d2ecdd23a19c01c9ab9ba60a11f179c4e7b1c545))
* **environment:** compare the setup file the way the gate does ([5755ce9](https://github.com/mancej-cyc/ai-harness/commit/5755ce99bd18feb665cedb26141b052c28849cb5))
* **environment:** require the plugin before reporting its setup state ([c11dbf7](https://github.com/mancej-cyc/ai-harness/commit/c11dbf78bc69ef72f1d9e0170f26c70a169c44c4))
* **files:** follow checkout links inside the HTML preview ([927fa5b](https://github.com/mancej-cyc/ai-harness/commit/927fa5b6a98f7557911b832f91c84a1486f99c27))
* **files:** follow checkout links inside the HTML preview ([27a857a](https://github.com/mancej-cyc/ai-harness/commit/27a857a3f3f73a003f9eda0caa48f3c998342b99))
* **foreman:** only retire a note once a pane form actually reached the child ([0fea35c](https://github.com/mancej-cyc/ai-harness/commit/0fea35cfd73c6f0180cb96bf5e426c5777c25a01))
* **foreman:** recover and diagnose Codex backlog planning ([#551](https://github.com/mancej-cyc/ai-harness/issues/551)) ([58b2cd1](https://github.com/mancej-cyc/ai-harness/commit/58b2cd152ba74047a98c8d475f70d8c873943f72))
* **foreman:** retire a pinned note when you answer the ask yourself ([479f716](https://github.com/mancej-cyc/ai-harness/commit/479f7160165d42bda55792f9573b386adfc06112))
* **foreman:** retire a pinned note when you answer the ask yourself ([5188f14](https://github.com/mancej-cyc/ai-harness/commit/5188f146bdd871cefee8f74b676d43e9b6ae31fb))
* **foreman:** skip shipping for non-shipping work ([#372](https://github.com/mancej-cyc/ai-harness/issues/372)) ([405ece2](https://github.com/mancej-cyc/ai-harness/commit/405ece297a3f362ae8d69ddfdf3cf5dccb9160b1))
* **harnesses:** make a saved per-harness model visibly take effect ([23ef442](https://github.com/mancej-cyc/ai-harness/commit/23ef4424144e1bf9a10530e1a8c6e7c0491e58c7))
* **harnesses:** make a saved per-harness model visibly take effect ([a694087](https://github.com/mancej-cyc/ai-harness/commit/a6940871a2f229ce842fdae4d783eca84e828f9f))
* **hooks:** bake durable paths from the installer ([#459](https://github.com/mancej-cyc/ai-harness/issues/459)) ([7e663f3](https://github.com/mancej-cyc/ai-harness/commit/7e663f367cb27e4a8329b2d0a37e42d7932bf171))
* **llm:** give a schema-carrying Claude SDK one-shot the turns it costs ([#534](https://github.com/mancej-cyc/ai-harness/issues/534)) ([0715185](https://github.com/mancej-cyc/ai-harness/commit/0715185e401a493b5926f8847a4615848b6b8b58))
* **outbox:** deliver queued turns on an embedded session's idle transition ([#374](https://github.com/mancej-cyc/ai-harness/issues/374)) ([8a82ca9](https://github.com/mancej-cyc/ai-harness/commit/8a82ca9d1765914433312d9877474adccb70d331))
* **pulse:** stop the topbar counting a blocked session the inbox cannot show ([94cd7a8](https://github.com/mancej-cyc/ai-harness/commit/94cd7a8f80fedb29956f9ddcc80b4c935ee833ac))
* **pulse:** stop the topbar counting a blocked session the inbox cannot show ([feb7148](https://github.com/mancej-cyc/ai-harness/commit/feb714895c9103df883532ede93156ec8213a5b1))
* quiet daemon proxy errors during development ([#362](https://github.com/mancej-cyc/ai-harness/issues/362)) ([5fc1c76](https://github.com/mancej-cyc/ai-harness/commit/5fc1c7632a0d86d4574375b43a1de24b3ca910dd))
* **resume:** carry the permission mode when continuing a session in a terminal ([2dba992](https://github.com/mancej-cyc/ai-harness/commit/2dba99286a0b67014ff1f6d1eab6e8a12fa5dfad))
* **sdk:** let every SDK session reach bypassPermissions ([#466](https://github.com/mancej-cyc/ai-harness/issues/466)) ([fd40ddd](https://github.com/mancej-cyc/ai-harness/commit/fd40ddd757219c76f728553100b8efaf6a8ad83a))
* **sdk:** restore idle sessions as idle ([#554](https://github.com/mancej-cyc/ai-harness/issues/554)) ([632afaf](https://github.com/mancej-cyc/ai-harness/commit/632afaf763fbd7cce7276a72bba9706366e9204d))
* **sessions:** restore click-to-rename on Agent SDK sessions ([f76496a](https://github.com/mancej-cyc/ai-harness/commit/f76496aa47ee3ce7edc0040908260a7ebb5ad4f9))
* **sessions:** restore click-to-rename on Agent SDK sessions ([5c9e037](https://github.com/mancej-cyc/ai-harness/commit/5c9e037571061338c5e0b190b87a6059df1fa5bc))
* **settings:** open a filtered ledger at its top, not at the last offset ([5f09ccf](https://github.com/mancej-cyc/ai-harness/commit/5f09ccf9ba47d159a559917dd984934b7b92656d))
* show send binding in conversation prompt ([5f54902](https://github.com/mancej-cyc/ai-harness/commit/5f549023fe1ed72ab36c8097bcafeb5b50c8b791))
* **skills:** stop the test suite uninstalling the operator's live Codex and Pi skills ([#384](https://github.com/mancej-cyc/ai-harness/issues/384)) ([6252e5c](https://github.com/mancej-cyc/ai-harness/commit/6252e5c56ed2d280619642f430dd596db5aa77f5))
* **test:** repair copied Electron framework link ([#676](https://github.com/mancej-cyc/ai-harness/issues/676)) ([97941b7](https://github.com/mancej-cyc/ai-harness/commit/97941b726c23a28c1499b94d53b1e4674ac3d771))
* **test:** stop foreman-spend-delivery's eventually() flaking under CI load ([162469a](https://github.com/mancej-cyc/ai-harness/commit/162469a638803239474a299385cbe6b6ed3f1114))
* **test:** stop session-action-runtime's waitFor flaking under full-suite load ([f5c9c63](https://github.com/mancej-cyc/ai-harness/commit/f5c9c63b17a8c22ff238b7c163854872a3997435))
* **test:** write the Codex runway fixture relative to now ([32fccb4](https://github.com/mancej-cyc/ai-harness/commit/32fccb4384378c3b645b314bd2233f487838d4b8))
* **test:** write the Codex runway fixture relative to now ([16e2e89](https://github.com/mancej-cyc/ai-harness/commit/16e2e899851cc8b0dd0ddce0e36deac8ced348ee))
* **topbar:** decide the responsive ladder by measurement, not by width ([7a03f51](https://github.com/mancej-cyc/ai-harness/commit/7a03f514a593e459e3d18e4d8c2338b4107d218a))
* **topbar:** decide the responsive ladder by measurement, not by width ([e818b52](https://github.com/mancej-cyc/ai-harness/commit/e818b52768cebd24763a801152436d7a927b1ff7))
* **topbar:** re-fit when the bar's content resizes at a fixed width ([bcf7e28](https://github.com/mancej-cyc/ai-harness/commit/bcf7e28db8b88e9dcd1924dc12769a207bd40790))
* **transcript:** restore conversation scrolling ([#342](https://github.com/mancej-cyc/ai-harness/issues/342)) ([b63cd53](https://github.com/mancej-cyc/ai-harness/commit/b63cd53caa8419356920d884b6016010ec5f6fa1))
* **workflows:** advance durable Inspector PR handoffs ([#346](https://github.com/mancej-cyc/ai-harness/issues/346)) ([01d6baf](https://github.com/mancej-cyc/ai-harness/commit/01d6bafc0a289c4735c4cb06082eca10b8219460))
* **workflows:** distinguish skipped stage outcomes ([#365](https://github.com/mancej-cyc/ai-harness/issues/365)) ([fc2ca02](https://github.com/mancej-cyc/ai-harness/commit/fc2ca024197ba0a81cd98c8779e0ca0b0ccba522))
* **workflows:** fall back to git for check worktrees ([f1412f7](https://github.com/mancej-cyc/ai-harness/commit/f1412f7929574e30137ed77628e17394a283fb91))
* **workflows:** fill the graph builder canvas ([#394](https://github.com/mancej-cyc/ai-harness/issues/394)) ([6f6f0fb](https://github.com/mancej-cyc/ai-harness/commit/6f6f0fb6936144ac277a29cdf6d93777cc27423c))
* **workflows:** give a Persona call ten minutes, not two ([#461](https://github.com/mancej-cyc/ai-harness/issues/461)) ([b065796](https://github.com/mancej-cyc/ai-harness/commit/b0657968aaf809abab9815dd4d61d00f78b0bf55))
* **workflows:** give the ＋ workflow bind chip back once a run is terminal ([#456](https://github.com/mancej-cyc/ai-harness/issues/456)) ([a6146ee](https://github.com/mancej-cyc/ai-harness/commit/a6146ee2975837fde204448cd76e8e7220dd5ab2))
* **workflows:** keep Reviewer verdicts to nodes that hold an opinion ([95fb0b9](https://github.com/mancej-cyc/ai-harness/commit/95fb0b9b98b1318907998d18ea4caf5a8398b7bb))
* **workflows:** preserve binding repair round overrides ([#393](https://github.com/mancej-cyc/ai-harness/issues/393)) ([2d49f83](https://github.com/mancej-cyc/ai-harness/commit/2d49f832788577e9f7ac6fa83cedd64bc9d28caf))
* **workflows:** preserve pinned binding reconciliation ([#622](https://github.com/mancej-cyc/ai-harness/issues/622)) ([9d4dd3a](https://github.com/mancej-cyc/ai-harness/commit/9d4dd3a2710ad60a823eed5a56b881dcc54f2e35))
* **workflows:** resume runs whose check cleanup resolved, and offer resubmit when blocked ([#399](https://github.com/mancej-cyc/ai-harness/issues/399)) ([3bed6b4](https://github.com/mancej-cyc/ai-harness/commit/3bed6b4878b33df3ac6955b68df5431ec8ec8bd4))
* **workflows:** show every stage member in the ladder, passed ones included ([29e613b](https://github.com/mancej-cyc/ai-harness/commit/29e613bf978d9ea77adafb052bc999548a7ae7a0))
* **workflows:** show every stage member in the ladder, passed ones included ([d269bb3](https://github.com/mancej-cyc/ai-harness/commit/d269bb313525fb97682197bbc25b25acd7876026))
* **workflows:** stop a status chip crushing the label beside it on a run ([#343](https://github.com/mancej-cyc/ai-harness/issues/343)) ([35dc18b](https://github.com/mancej-cyc/ai-harness/commit/35dc18b9926531549bb90fc42eb332907ec332c9))


### Performance Improvements

* **workflows:** accelerate submission and run loading ([#383](https://github.com/mancej-cyc/ai-harness/issues/383)) ([9e96b67](https://github.com/mancej-cyc/ai-harness/commit/9e96b6758b437de5098176bbeb03657fbd8482e5))
