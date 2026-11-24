// The everyday words a spoken name is warned against (`common-word` in `validateSpokenName`).
//
// Browser-safe and data only. Voice routes an utterance to the agent whose name is its first
// word (`docs/voice-spike-findings.md`, S3), so a name that ordinary speech often starts with -
// "Will you grab the door?" - sends that speech to the agent. The list is the words a sentence
// spoken near a microphone plausibly starts with, plus the first names that are also such words.
// It is deliberately not a dictionary: "Carol" and "Atlas" are words, and nobody starts a
// sentence with them by accident.
//
// Lowercase, one word each. Extend by appending; order carries no meaning.

const WORDS = `
a about above after again against all almost also although always am among an and another any
anybody anyone anything anyway are around as at away back be because been before behind being
below beside best better between both but by can could did do does doing done down during each
either else enough even ever every everybody everyone everything few for from further get gets
getting go goes going gone got had has have having he her here hers herself him himself his how
however i if in inside instead into is it its itself just least less let lets like many may maybe
me might mine more most much must my myself neither never next no nobody none nor not nothing now
of off often on once one only onto or other others our ours ourselves out over own perhaps please
quite rather really same several shall she should since so some somebody someone something
sometimes soon still such than that the their theirs them themselves then there these they this
those though through thus till to today together tomorrow tonight too toward towards under unless
until up upon us very was we well were what whatever when whenever where wherever whether which
while who whoever whole whom whose why with within without would yes yesterday yet you your yours
yourself yourselves

ok okay hey hi hello bye goodbye thanks thank yeah yep yup nope oh ah uh um hmm huh wow alright
sure right wait look listen actually basically honestly literally seriously sorry excuse cheers
great cool nice fine good bad

ask become begin believe bring build buy call change check clean clear close come consider
continue cut decide delete deploy draw drive drop eat end enter expect explain fall feel fight
fill find finish fix follow forget give grab grow handle happen hear help hold hope keep know
laugh lead learn leave lie listen live lose love make mean meet merge miss move need open pay
pick place plan play point pull push put reach read remember remove report rest return review
ring rise run save say see seem sell send set show shut sit sleep speak spend stand start stay
step stick stop study take talk teach tell test think throw touch try turn understand use wake
walk want warn wash watch wear win wish work worry write ship release update commit fetch rebase
retry restart resume pause

area back bag ball bank base bed bird body book box boy branch bug business car case cat cause
center chance child city class code color company computer cost country course day deal dog door
eye face fact family file fire floor food friend game girl group guy hand head heart home hour
house idea issue job key kid kind land law level life light line list lot man market matter mind
minute money month morning mother father name night note number office page paper part party
people person phone picture point power problem program question reason result room rule school
second side sound state status story street student system table task team thing time top town
tree type war water way week window woman word world year build

able big black blue bright brown cold dark dead deep different early easy empty fair far fast
first free full gray grey green half happy hard high hot huge important large last late left
little long low main major new old past poor possible quick ready real red round sad safe short
simple slow small soft strong sweet tall true warm white wide wild wrong young

two three four five six seven eight nine ten hundred thousand third twice already

will bill mark grace hope faith joy rose sage art bob jack frank rob pat sue don ray max amber
ruby jade iris ivy holly dawn june april august summer autumn daisy lily violet hunter chase drew
gene glen dean earl penny sky river stone rich sandy rusty buddy chip basil heather brook cliff
dale wade miles pearl crystal destiny harmony melody honey candy ginger pepper hazel olive willow
forest storm rain sunny star angel hero king queen prince duke judge baker cook carter mason
porter grant nick pete rod sonny skip bud bee ace robin sunday may
`;

/** Every word on the list, lowercase. */
export const VOICE_COMMON_WORDS: ReadonlySet<string> = new Set(WORDS.split(/\s+/).filter(Boolean));
