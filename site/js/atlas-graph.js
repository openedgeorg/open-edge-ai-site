/**
 * The Atlas concept graph: islands, paths and the regions they sit in.
 *
 * Every island and every path is traced to the notes allowance architecture summary
 * (the local draft brain, not company-approved). `trace` records the section and a
 * verbatim anchor phrase from that summary (whitespace-normalised). The anchors are
 * data for authors and tests. The page never renders them: it shows island names,
 * one-line teaser questions, short path labels and section numbers only.
 *
 * Contested items carry `status: "contested"`. The open list of the summary (section 10,
 * and the undefined post-pilot emergency settlement of section 6) carries `status: "open"`.
 */

export const VIEWBOX = { width: 1240, height: 780 };
export const START_ID = "internet-bill";
export const FIRST_SUGGESTION = "Who actually pays the apps I use?";
export const EDGE_DRAGON_CAPTION = "Unfinished. You will get here.";
export const OPEN_LABEL = "open, not ratified";
export const CONTESTED_LABEL = "awaits incorporation";

export const REGIONS = [
  { id: "coast", level: "L0", name: "The Coast", subtitle: "The promise", x: 90 },
  { id: "lowlands", level: "L1", name: "The Lowlands", subtitle: "Living with an allowance", x: 235 },
  { id: "interior", level: "L2", name: "The Interior", subtitle: "Money plumbing", x: 385 },
  { id: "highlands", level: "L3", name: "The Highlands", subtitle: "Signed facts", x: 535 },
  { id: "mountains", level: "L4", name: "The Mountains", subtitle: "Masks", x: 680 },
  { id: "valley", level: "L5", name: "The Deep Valley", subtitle: "Month-end machinery", x: 830 },
  { id: "badlands", level: "L6", name: "The Badlands", subtitle: "Disputes and attacks", x: 985 },
  { id: "dragons", level: "L7", name: "Here be dragons", subtitle: "Open, not ratified", x: 1135 },
];

export const ISLANDS = [
  // ---- L0 The Coast: the promise (section 1) ----
  {
    id: "isp-counterparty", name: "ISP as your counterparty", region: "coast", x: 110, y: 126,
    teaser: "Why do I pay my ISP instead of billing each app separately?",
    trace: [{ section: 1, anchor: "financial counterparty for participating Internet services" }],
    terms: ["financial counterparty", "counterparty", "separate billing relationship"],
  },
  {
    id: "app-set-prices", name: "Apps set their own prices", region: "coast", x: 95, y: 238,
    teaser: "Do apps share a fixed subscription pool, like on Spotify?",
    trace: [
      { section: 1, anchor: "ESP explicitly chooses app-set prices over Spotify-style fixed-pot" },
      { section: 1, anchor: "The allowance reconciles flat-rate experience with usage-based provider" },
    ],
    terms: ["app-set prices", "app-set", "Spotify", "fixed-pot sharing", "fixed subscription pool", "sets its tariff", "usage-based provider economics"],
  },
  {
    id: "internet-bill", name: "Your internet bill", region: "coast", x: 112, y: 382, start: true,
    teaser: "Does ESP change what I pay my ISP each month?",
    trace: [
      { section: 1, anchor: "the household pays its ISP under one standing plan" },
      { section: 3, anchor: "ESP consumption, allowance top-ups, and ISP debt cannot automatically increase" },
    ],
    terms: ["internet bill", "your bill", "ISP bill", "monthly bill", "agreed plan price"],
  },
  {
    id: "standing-plan", name: "One standing plan", region: "coast", x: 90, y: 487,
    teaser: "Why a fixed monthly plan instead of paying per app?",
    trace: [{ section: 1, anchor: "The household buys predictable access rather than a sequence of isolated" }],
    terms: ["standing plan", "fixed monthly plan", "predictable access", "flat-rate", "flat rate"],
  },
  {
    id: "monthly-epochs", name: "Monthly epochs", region: "coast", x: 93, y: 677,
    teaser: "What happens during one ESP month?",
    trace: [{ section: 1, anchor: "The architecture runs in monthly epochs" }],
    terms: ["monthly epoch", "monthly epochs", "ESP epoch"],
  },

  // ---- L1 The Lowlands: living with an allowance (sections 1, 3) ----
  {
    id: "funding-pressure", name: "Prices push on the ISP", region: "lowlands", x: 228, y: 131,
    teaser: "Can app price rises end up in my plan price?",
    trace: [
      { section: 1, anchor: "App prices transmit rising service costs into ISP funding pressure" },
      { section: 1, anchor: "Price pressure does not bypass retail or funding limits" },
    ],
    terms: ["funding pressure", "price pressure", "rising service costs", "future household plan prices"],
  },
  {
    id: "price-feedback", name: "Price feedback by experience", region: "lowlands", x: 229, y: 242,
    teaser: "How would I notice that an app has become expensive?",
    trace: [
      { section: 1, anchor: "ESP chooses user experience as the household" },
      { section: 3, anchor: "Economic feedback from app prices works through household user experience" },
    ],
    terms: ["price feedback", "economic feedback", "immediate economic feedback", "household user experience"],
  },
  {
    id: "household-analytics", name: "Household analytics", region: "lowlands", x: 247, y: 332,
    teaser: "Can I see which app is using up my allowance?",
    trace: [{ section: 3, anchor: "Household analytics make the cost of app choices visible" }],
    terms: ["household analytics", "analytics shows", "consumption by app", "tariff increases from increased usage"],
  },
  {
    id: "fup-faucet", name: "The FUP faucet", region: "lowlands", x: 234, y: 410,
    teaser: "How does my ISP decide how much extra to give me?",
    trace: [
      { section: 3, anchor: "Fair-use policy is implemented as an allowance faucet" },
      { section: 3, anchor: "a tail reserve prevents the buffer from being fully allocated" },
    ],
    terms: ["FUP faucet", "allowance faucet", "fair-use policy", "fair use policy", "faucet", "tail reserve", "rate cap", "rate caps", "top-up buffer"],
  },
  {
    id: "base-and-topups", name: "Base allowance and top-ups", region: "lowlands", x: 272, y: 503,
    teaser: "If I run out, can I ask for more?",
    trace: [
      { section: 3, anchor: "Every household has one fungible monthly allowance" },
      { section: 3, anchor: "The base allowance is guaranteed while top-ups are conditional" },
    ],
    terms: ["base allowance", "guaranteed base", "fungible", "one allowance", "top-up entitlements", "top-ups are conditional", "conditional top-ups"],
  },
  {
    id: "retail-contract", name: "The retail contract", region: "lowlands", x: 225, y: 588,
    teaser: "Who decides how big my allowance is?",
    trace: [
      { section: 3, anchor: "subscriber contract defines the retail promise" },
      { section: 8, anchor: "The protocol deliberately leaves retail product design outside consensus" },
    ],
    terms: ["subscriber contract", "retail contract", "retail promise", "retail terms", "retail product design", "contractual maximum"],
  },
  {
    id: "signed-refusal", name: "A refusal you can prove", region: "lowlands", x: 276, y: 658,
    teaser: "What if my ISP refuses a top-up I was promised?",
    trace: [
      { section: 3, anchor: "the signed refusal gives the household evidence" },
      { section: 3, anchor: "opening, grant, or refusal produces a Household Signed Allowance Message" },
    ],
    terms: ["signed refusal", "legitimate refusal"],
  },

  // ---- L2 The Interior: money plumbing (section 2) ----
  {
    id: "common-fund", name: "The common fund", region: "interior", x: 380, y: 100,
    teaser: "Where does the money for the apps actually sit?",
    trace: [{ section: 2, anchor: "ESP operates one common protocol-level fund" }],
    terms: ["common fund", "common-fund", "protocol-level fund"],
  },
  {
    id: "isp-commitment", name: "ISP monthly commitment", region: "interior", x: 378, y: 261,
    teaser: "What does my ISP prepay each month, and for whom?",
    trace: [{ section: 2, anchor: "Each ISP prepays a monthly commitment for every participating household" }],
    terms: ["monthly commitment", "monthly commitments", "ISP commitment", "ISP commitments", "prepays"],
  },
  {
    id: "the-pot", name: "The pot", region: "interior", x: 405, y: 337,
    teaser: "What is the pot an ISP gets each month?",
    trace: [
      { section: 2, anchor: "The protocol assigns each ISP a monthly pot" },
      { section: 2, anchor: "the pot is spending authority, not money transferred to the ISP" },
      { section: 3, anchor: "non-negotiable solvency boundary" },
    ],
    terms: ["the pot", "monthly pot", "spending envelope", "spending authority", "hard ceiling", "solvency boundary"],
  },
  {
    id: "overdraft", name: "Overdraft", region: "interior", x: 424, y: 408,
    teaser: "Can the pot be bigger than what the ISP committed?",
    trace: [
      { section: 2, anchor: "the difference is an overdraft limit backed by the common fund" },
      { section: 2, anchor: "New ISPs receive no unsecured overdraft by default" },
      { section: 2, anchor: "The total pots assigned across all ISPs cannot exceed the common fund" },
    ],
    terms: ["overdraft", "overdraft limit", "unsecured overdraft"],
  },
  {
    id: "isp-debt", name: "Debt from executed use", region: "interior", x: 415, y: 512,
    teaser: "When does an ISP actually owe the fund money?",
    trace: [
      { section: 2, anchor: "Debt arises only from executed consumption" },
      { section: 2, anchor: "Debt preserves financial accountability while allowing temporary support" },
      { section: 2, anchor: "can lose money only through actual ISP default" },
    ],
    terms: ["executed consumption", "ISP debt", "ISP liability", "liability to the common fund", "ISP default", "debt arises"],
  },
  {
    id: "debt-update", name: "The monthly debt update", region: "interior", x: 420, y: 630,
    teaser: "How is an ISP's debt recalculated after each month?",
    trace: [
      { section: 2, anchor: "debt is updated mechanically" },
      { section: 2, anchor: "New communal surplus is recognized only after" },
      { section: 2, anchor: "Every capital-account update is publicly reproducible" },
      { section: 2, anchor: "Debt-service payments create no new allowance or pot capacity" },
    ],
    terms: ["debt update", "debt service", "debt-service", "capital account", "capital-account", "communal surplus", "correction funding", "opening debt", "closing debt"],
  },
  {
    id: "commitment-floor", name: "The commitment floor", region: "interior", x: 350, y: 699,
    teaser: "What happens to an ISP that keeps underfunding?",
    trace: [
      { section: 2, anchor: "Persistent underfunding eventually creates a binding commitment floor" },
      { section: 2, anchor: "cannot open another ESP epoch" },
    ],
    terms: ["commitment floor", "binding commitment floor", "persistent underfunding", "underfunding"],
  },

  // ---- L3 The Highlands: signed facts (sections 3, 4) ----
  {
    id: "price-catalogue", name: "Epoch price catalogue", region: "highlands", x: 536, y: 117,
    status: "contested", label: "awaits incorporation",
    teaser: "How is an app's price meant to become binding for the month?",
    trace: [
      { section: 4, anchor: "Each app publishes one signed price catalogue for the epoch" },
      { section: 4, anchor: "Accepted prices remain fixed for the epoch" },
      { section: "preamble", anchor: "awaits incorporation into the authoritative design and message catalogue" },
    ],
    terms: ["price catalogue", "price-catalogue", "signed price catalogue", "accepted catalogue", "tariff agreement"],
  },
  {
    id: "conrec", name: "Consumption Record (ConRec)", region: "highlands", x: 538, y: 246,
    teaser: "What proves that I really used an app?",
    trace: [{ section: 4, anchor: "Every billable act produces a Consumption Record (ConRec) signed by both" }],
    terms: ["ConRec", "ConRecs", "Consumption Record", "Consumption Records"],
  },
  {
    id: "optimistic-serving", name: "Optimistic serving", region: "highlands", x: 550, y: 369,
    teaser: "Can an app serve me before my top-up arrives?",
    trace: [{ section: 4, anchor: "Serving can remain optimistic" }],
    terms: ["optimistic serving", "optimistic service", "optimistic credit"],
  },
  {
    id: "evidence-kept", name: "Evidence kept off-chain", region: "highlands", x: 515, y: 432,
    teaser: "Where do the signed records live, and for how long?",
    trace: [
      { section: 4, anchor: "Price agreements and fine-grained evidence remain off-chain during" },
      { section: 4, anchor: "Evidence retention outlives payment finality" },
      { section: 8, anchor: "Apps are both service providers and evidence custodians" },
    ],
    terms: ["off-chain", "evidence retention", "evidence custodians", "local diary", "retention period"],
  },
  {
    id: "hsatm", name: "Signed allowance message (HSATM)", region: "highlands", x: 554, y: 553,
    teaser: "Who signs my allowance, and what exactly do they sign?",
    trace: [
      { section: 3, anchor: "Every allowance decision becomes a jointly signed historical fact" },
      { section: 3, anchor: "the highest-sequence HSATM carries the authoritative" },
    ],
    terms: ["HSATM", "HSATMs", "HSAT", "Household Signed Allowance Message", "Household Signed Allowance Total", "highest-sequence", "signed allowance message"],
  },
  {
    id: "box-hlaa", name: "The box declines to sign", region: "highlands", x: 527, y: 672,
    teaser: "What does my box do when my allowance runs out?",
    trace: [
      { section: 3, anchor: "The normal box enforces the allowance locally" },
      { section: 3, anchor: "household-local allowance account" },
      { section: 8, anchor: "The household box is an observer in the pilot" },
    ],
    terms: ["HLAA", "declines to sign", "decline to sign", "declining to sign", "enforces the allowance locally", "household-local allowance account"],
  },

  // ---- L4 The Mountains: masks (section 5) ----
  {
    id: "heid", name: "Fresh key, fresh HEID", region: "mountains", x: 668, y: 129,
    teaser: "Can apps follow me from one month to the next?",
    trace: [
      { section: 5, anchor: "A household receives a fresh cryptographic identity for every epoch" },
      { section: 5, anchor: "The epoch-opening allowance message binds identity to entitlement" },
    ],
    terms: ["HEID", "HEIDs", "household epoch ID", "epoch ID", "epoch keypair", "epoch key", "fresh keypair", "fresh cryptographic identity"],
  },
  {
    id: "identity-layers", name: "Three layers of identity", region: "mountains", x: 687, y: 230,
    teaser: "Who can see who I am, and who can't?",
    trace: [
      { section: 5, anchor: "The identity model has three deliberate layers" },
      { section: 5, anchor: "Only the parent ISP can resolve a public claim to a household" },
      { section: 5, anchor: "Ordinary request-level Consumption Records remain with the household and" },
    ],
    terms: ["three layers", "identity layers", "three identity layers", "identity model", "parent ISP", "request-level Consumption Records"],
  },
  {
    id: "encrypted-heids", name: "Encrypted HEIDs", region: "mountains", x: 662, y: 319,
    teaser: "Why can't two apps tell, from public claims, that they share a customer?",
    trace: [
      { section: 5, anchor: "Fresh encryption randomness prevents public basket reconstruction" },
      { section: 5, anchor: "HEID encrypted with the parent ISP" },
    ],
    terms: ["encrypted HEID", "encrypted HEIDs", "encrypted epoch ID", "fresh randomness", "encryption randomness", "unlinkable ciphertexts"],
  },
  {
    id: "verification-tag", name: "The verification tag", region: "mountains", x: 678, y: 428,
    teaser: "How can I find my own entry in a public list?",
    trace: [
      { section: 5, anchor: "The ISP and box also share one private verification secret" },
      { section: 5, anchor: "The AtS verification tag gives a household visibility without giving apps a" },
      { section: 9, anchor: "encrypted HEIDs and private verification tags deny the app that lookup" },
    ],
    terms: ["verification tag", "verification tags", "verification secret", "rotating tag", "one-way tag", "allowance lookup"],
  },
  {
    id: "ats", name: "Allowance to Spend (AtS)", region: "mountains", x: 678, y: 548,
    teaser: "What is the public list of closing allowances?",
    trace: [
      { section: 5, anchor: "The public Allowance to Spend (AtS) is anonymous but self-verifiable" },
      { section: 6, anchor: "Each ISP posts one closing allowance list for the epoch" },
      { section: 6, anchor: "The AtS is a closing report rather than a live spending oracle" },
    ],
    terms: ["AtS", "Allowance to Spend", "closing allowance list"],
  },
  {
    id: "ishec", name: "IsHEC against your diary", region: "mountains", x: 673, y: 680,
    teaser: "How do I check what my ISP says I consumed?",
    trace: [
      { section: 5, anchor: "The household independently checks both sides of its monthly equation" },
      { section: 5, anchor: "The IsHEC must reach the household while payment can still be stopped" },
    ],
    terms: ["IsHEC", "Household Epoch Consumption", "charged total", "private signed total"],
  },

  // ---- L5 The Deep Valley: month-end machinery (sections 6, 8) ----
  {
    id: "epoch-timetable", name: "The epoch timetable", region: "valley", x: 832, y: 126,
    teaser: "In what order does a month's machinery run?",
    trace: [
      { section: 8, anchor: "The epoch timetable prevents races and premature sweeps" },
      { section: 6, anchor: "The pilot uses a hard deadline for app claims" },
      { section: 8, anchor: "Blockchain load scales with participants and disputes rather than usage" },
    ],
    terms: ["epoch timetable", "challenge window", "claim deadline", "hard deadline", "on-chain footprint", "blockchain load", "fixed epoch footprint"],
  },
  {
    id: "hcd", name: "Opening the month: the HCD", region: "valley", x: 787, y: 183,
    teaser: "How does an ISP open a month?",
    trace: [{ section: 6, anchor: "The ISP opens every epoch by declaring and funding its participating" }],
    terms: ["HCD", "HCDs", "Household Commitment Declaration"],
  },
  {
    id: "rtgp", name: "Request to get Paid (RtgP)", region: "valley", x: 869, y: 244,
    teaser: "How does an app get paid for a month of requests?",
    trace: [
      { section: 6, anchor: "Each app converts many service requests into one monthly claim" },
      { section: 6, anchor: "carries publicly checkable ISP subtotals" },
    ],
    terms: ["RtgP", "RtgPs", "Request to get Paid", "monthly claim"],
  },
  {
    id: "reconcile-together", name: "Reconciling all claims together", region: "valley", x: 793, y: 294,
    teaser: "Does the first app to claim get first dibs on my allowance?",
    trace: [
      { section: 6, anchor: "The ISP reconciles all apps together rather than processing claims in" },
      { section: 8, anchor: "The ISP is trusted with private mapping and computation but not with payment" },
    ],
    terms: ["reconciles all apps together", "arrival order", "all claims together", "combined claims", "payment discretion"],
  },
  {
    id: "heea", name: "Household escrow account (HEEA)", region: "valley", x: 831, y: 387,
    teaser: "What caps what can be paid for one household?",
    trace: [{ section: 6, anchor: "A household escrow account is an accounting container, not a separate money" }],
    terms: ["HEEA", "HEEAs", "household epoch escrow account", "household escrow account", "escrow account", "escrow cap"],
  },
  {
    id: "iptd", name: "The IPtD: proposed payouts", region: "valley", x: 784, y: 468,
    teaser: "What does the ISP publish about who gets paid?",
    trace: [
      { section: 6, anchor: "The IPtD publishes settlement outcomes without exposing household app" },
      { section: 6, anchor: "Public verification checks arithmetic" },
      { section: 8, anchor: "constructs the disbursement plan" },
    ],
    terms: ["IPtD", "IPtDs", "disbursement plan", "settlement outcomes", "public verification"],
  },
  {
    id: "freeze-settle", name: "Settle clean, freeze flagged", region: "valley", x: 853, y: 542,
    teaser: "What happens when a household's claims exceed its cap?",
    trace: [
      { section: 6, anchor: "Clean households settle and flagged households freeze" },
      { section: 7, anchor: "Freezing an overrun normally prevents fraudulent money from leaving the" },
    ],
    terms: ["the freeze", "flagged households", "clean households", "freezes every row", "freezing an overrun", "overrun flag"],
  },
  {
    id: "slashing-collateral", name: "Slashing and collateral", region: "valley", x: 868, y: 616,
    teaser: "What does an ISP or an app stand to lose if it breaks the rules?",
    trace: [
      { section: 6, anchor: "collateral slashing and forced wind-down" },
      { section: 8, anchor: "Every app must post enough registration collateral to make disposable" },
    ],
    terms: ["slashing", "slashed", "collateral", "wind-down", "registration collateral", "disposable padding identities"],
  },
  {
    id: "emergency-settlement", name: "Emergency settlement (pilot)", region: "valley", x: 798, y: 681,
    teaser: "What if the ISP misses its IPtD deadline in the pilot?",
    trace: [{ section: 6, anchor: "A missing pilot IPtD invokes emergency settlement" }],
    terms: ["emergency settlement", "missing IPtD", "reveal their HEIDs"],
  },

  // ---- L6 The Badlands: disputes and attacks (sections 3, 6, 7, 8, 9) ----
  {
    id: "evidence-round", name: "Evidence rounds and the CfEfA", region: "badlands", x: 987, y: 128,
    teaser: "What triggers a dispute, and what gets made public?",
    trace: [
      { section: 7, anchor: "An evidence round can arise from three provable triggers" },
      { section: 7, anchor: "A Call for Evidence turns the dispute into a bounded public proceeding" },
      { section: 7, anchor: "ConRecs are posted in plaintext" },
    ],
    terms: ["evidence round", "evidence rounds", "CfEfA", "Call for Evidence", "in plaintext", "bounded public proceeding"],
  },
  {
    id: "mechanical-resolution", name: "Mechanical resolution", region: "badlands", x: 945, y: 202,
    teaser: "Is a dispute meant to be settled by arithmetic or discretion?",
    trace: [
      { section: 7, anchor: "Resolution is designed to be mechanical rather than discretionary" },
      { section: 7, anchor: "False inclusion in an evidence call is self-correcting" },
    ],
    terms: ["mechanical resolution", "mechanical rather than discretionary", "signed denial", "witness list", "self-correcting"],
  },
  {
    id: "escalation-audit", name: "Escalation audit", region: "badlands", x: 1009, y: 243,
    teaser: "What happens to an app caught with one fake row?",
    trace: [
      { section: 7, anchor: "An unsupported row is app fraud" },
      { section: 7, anchor: "An escalation audit follows the app across every retained claim it can" },
    ],
    terms: ["escalation audit", "escalation audits", "unsupported row", "app fraud"],
  },
  {
    id: "silent-padding", name: "Silent padding", region: "badlands", x: 960, y: 308,
    teaser: "How could an app invent charges that stay under my cap?",
    trace: [
      { section: 9, anchor: "Silent padding hides a fabricated app charge below the household" },
      { section: 7, anchor: "Ordinary silent padding is exposed through overlapping signals" },
    ],
    terms: ["silent padding", "targeted silent padding", "fabricated app charge"],
  },
  {
    id: "household-fraud", name: "Household fraud: the pro-rata split", region: "badlands", x: 1014, y: 374,
    teaser: "What if a household really consumed more than its allowance?",
    trace: [
      { section: 7, anchor: "Valid consumption beyond the closing allowance is household fraud" },
      { section: 7, anchor: "A false closing allowance cannot be used to convict an honest household" },
      { section: 7, anchor: "A dishonest household cannot make the common fund exceed its funded" },
    ],
    terms: ["household fraud", "pro-rata haircuts", "divided pro rata", "absorb the shortfall", "shaved entry"],
  },
  {
    id: "timing-states", name: "Three timing states of an audit", region: "badlands", x: 966, y: 455,
    teaser: "How does an audit tell a fair top-up race from cheating?",
    trace: [
      { section: 3, anchor: "The ex-post audit separates three timing states" },
      { section: 9, anchor: "Spend-ahead consumes future allowance before the ISP grants it" },
    ],
    terms: ["timing states", "pending-grant race", "spend-ahead", "ex-post audit"],
  },
  {
    id: "hoarding", name: "Hoarding", region: "badlands", x: 932, y: 586,
    teaser: "Why is asking for a top-up far ahead of need a violation?",
    trace: [
      { section: 9, anchor: "Allowance hoarding front-runs the ISP" },
      { section: 3, anchor: "Hoarding and spend-ahead are contractual violations even if later events" },
    ],
    terms: ["hoarding", "allowance hoarding", "front-runs"],
  },
  {
    id: "fup-audit", name: "FUP audits: private, then bilateral", region: "badlands", x: 998, y: 611,
    note: "A production implementation may reduce exposure with zero-knowledge proofs",
    teaser: "How is my top-up behaviour audited, in the pilot and after?",
    trace: [
      { section: 3, anchor: "Pilot household timing audits stay private" },
      { section: 3, anchor: "Post-pilot FUP audits are bilateral" },
      { section: 3, anchor: "a production implementation may reduce this exposure by letting the box prove" },
    ],
    terms: ["FUP audit", "FUP audits", "timing audit", "timing audits", "bilateral", "zero knowledge", "zero-knowledge", "ZK"],
  },
  {
    id: "pilot-operator", name: "The pilot operator", region: "badlands", x: 943, y: 699,
    teaser: "Who carries a household's evidence into the protocol?",
    trace: [
      { section: 8, anchor: "The pilot operator bridges household findings into protocol action" },
      { section: 8, anchor: "Commitment declarations are privately auditable without publishing" },
    ],
    terms: ["pilot operator", "second instance"],
  },
  {
    id: "settlement-finality", name: "Final at execution (pilot)", region: "badlands", x: 985, y: 529,
    teaser: "In the pilot, can an executed payment be reversed?",
    trace: [
      { section: 6, anchor: "Pilot settlement becomes final when execution runs" },
      { section: 7, anchor: "support slashing, expulsion, and external recovery rather than reversal of final payments" },
    ],
    terms: ["settlement is final", "final when execution", "immutable", "finality", "executed payments"],
  },

  // ---- L7 Here be dragons: open, not ratified (section 10, and section 6) ----
  {
    id: "tariff-format", name: "Tariff-agreement format", region: "dragons", x: 1168, y: 102,
    status: "open", label: "open, not ratified",
    teaser: "What is still unspecified about tariff agreements?",
    trace: [{ section: 10, anchor: "Epoch tariff agreements still need a format and evidence specification" }],
    terms: ["format and evidence specification", "tariff-agreement format", "catalogue identifiers", "acceptance binding"],
  },
  {
    id: "credit-calibration", name: "Credit-policy calibration", region: "dragons", x: 1083, y: 185,
    status: "open", label: "open, not ratified",
    teaser: "Which parts of the ISP credit policy still need calibration?",
    trace: [{ section: 10, anchor: "The ISP credit policy still needs numerical calibration" }],
    terms: ["credit policy", "credit-policy", "debt ceilings", "debt ageing", "collateral ratios", "amortization schedules", "default waterfall", "numerical calibration"],
  },
  {
    id: "dishonest-isp", name: "Dishonest-ISP analysis", region: "dragons", x: 1178, y: 244,
    status: "open", label: "open, not ratified",
    teaser: "Which dishonest-ISP cases must the design still test?",
    trace: [{ section: 10, anchor: "Dishonest-ISP analysis remains incomplete" }],
    terms: ["dishonest-ISP", "dishonest ISP", "allowance shaving", "tag-to-ciphertext"],
  },
  {
    id: "collusion-padding", name: "ISP-and-app collusion", region: "dragons", x: 1101, y: 301,
    status: "open", label: "open, not ratified",
    teaser: "Is there a padding attack the design cannot yet stop?",
    trace: [{ section: 10, anchor: "ISP-and-app collusion still has an undefeated silent-padding form" }],
    terms: ["ISP-and-app collusion", "ISP and app collusion", "undefeated silent-padding", "accomplice app"],
  },
  {
    id: "anti-collusion", name: "Anti-collusion candidates", region: "dragons", x: 1175, y: 358,
    status: "open", label: "open, not ratified",
    teaser: "Which anti-collusion ideas are only candidates so far?",
    trace: [{ section: 10, anchor: "Several production anti-collusion mechanisms remain candidates" }],
    terms: ["anti-collusion", "charged-total annex", "broadcast evidence summons", "compelled verifiable decryption", "random evidence sampling"],
  },
  {
    id: "borrow-and-default", name: "Borrow-and-default", region: "dragons", x: 1102, y: 415,
    status: "open", label: "open, not ratified",
    teaser: "When would turning an ISP overdraft into cash pay off?",
    trace: [{ section: 10, anchor: "Borrow-and-default replaces consumption-weighted allocation farming" }],
    terms: ["borrow-and-default", "borrow and default", "wash app", "allocation farming"],
  },
  {
    id: "durable-second-instance", name: "A durable second instance", region: "dragons", x: 1170, y: 496,
    status: "open", label: "open, not ratified",
    teaser: "Why is the pilot operator only a temporary second instance?",
    trace: [{ section: 10, anchor: "Production needs a durable second instance" }],
    terms: ["durable second instance", "temporary institutional answer"],
  },
  {
    id: "finality-horizon", name: "Finality and clawback horizon", region: "dragons", x: 1085, y: 553,
    status: "open", label: "open, not ratified",
    teaser: "How is fraud found after payment handled, and what is still open?",
    trace: [{ section: 10, anchor: "Production needs a deliberate finality and clawback horizon" }],
    terms: ["clawback horizon", "restitution routing", "offsets against future payouts"],
  },
  {
    id: "isp-fronting", name: "ISP fronting of shortfalls", region: "dragons", x: 1179, y: 610,
    status: "open", label: "open, not ratified",
    teaser: "Could the ISP pay apps in full and recover from the household?",
    trace: [{ section: 10, anchor: "ISP fronting of household shortfalls remains optional future work" }],
    terms: ["ISP fronting", "fronting of household shortfalls", "obligatory insurer"],
  },
  {
    id: "post-pilot-emergency", name: "Post-pilot emergency settlement", region: "dragons", x: 1106, y: 667,
    status: "open", label: "open, not ratified", note: "Undefined after the pilot",
    teaser: "Is there a post-pilot equivalent of emergency settlement?",
    trace: [{ section: 6, anchor: "the equivalent post-pilot recovery mechanism remains undefined" }],
    terms: ["post-pilot recovery mechanism", "post-pilot emergency settlement", "equivalent post-pilot"],
  },
];

export const EDGES = [
  // Coast and Lowlands
  { a: "internet-bill", b: "isp-counterparty", label: "pays its ISP under one standing plan", trace: { section: 1, anchor: "the household pays its ISP under one standing plan" } },
  { a: "internet-bill", b: "standing-plan", label: "predictable access, not isolated purchases", trace: { section: 1, anchor: "The household buys predictable access rather than a sequence of isolated" } },
  { a: "internet-bill", b: "retail-contract", label: "the bill stays bounded by the retail contract", trace: { section: 3, anchor: "financial exposure remains bounded by its retail contract" } },
  { a: "internet-bill", b: "funding-pressure", label: "app prices do not raise the bill by themselves", trace: { section: 1, anchor: "do not automatically enlarge the pot, authorize top-ups, or increase" } },
  { a: "isp-counterparty", b: "app-set-prices", label: "apps earn through the protocol, at accepted prices", trace: { section: 1, anchor: "apps earn through the protocol instead of establishing a separate billing" } },
  { a: "standing-plan", b: "app-set-prices", label: "flat-rate experience, usage-based pay", trace: { section: 1, anchor: "The allowance reconciles flat-rate experience with usage-based provider" } },
  { a: "standing-plan", b: "base-and-topups", label: "the plan funds general spending capacity", trace: { section: 1, anchor: "a fixed monthly plan finances general spending capacity" } },
  { a: "app-set-prices", b: "funding-pressure", label: "higher prices can push payouts past ISP contributions", trace: { section: 1, anchor: "payouts within funded allowances can exceed ISP contributions and create debt" } },
  { a: "app-set-prices", b: "price-feedback", label: "higher prices consume allowance faster", trace: { section: 1, anchor: "higher prices consume allowance faster" } },
  { a: "price-feedback", b: "household-analytics", label: "analytics shows the costly app", trace: { section: 3, anchor: "Analytics shows the costly" } },
  { a: "household-analytics", b: "box-hlaa", label: "the box shows consumption by app", trace: { section: 3, anchor: "the box shows allowance consumption by app" } },
  { a: "price-feedback", b: "fup-faucet", label: "FUP can limit expected app use", trace: { section: 1, anchor: "can limit expected app use under FUP" } },
  { a: "monthly-epochs", b: "isp-commitment", label: "commitments and pots come before serving", trace: { section: 1, anchor: "commitments and pots are established before serving" } },
  { a: "base-and-topups", b: "retail-contract", label: "the plan sets base, top-ups and rate limits", trace: { section: 3, anchor: "the plan sets the base, top-up entitlements, rate limits, and contractual maximum" } },
  { a: "base-and-topups", b: "fup-faucet", label: "a top-up request carries no amount", trace: { section: 3, anchor: "the request carries no amount" } },
  { a: "base-and-topups", b: "signed-refusal", label: "a refusal is legitimate if it follows the subscribed FUP", trace: { section: 3, anchor: "is legitimate when it follows the subscribed FUP" } },
  { a: "fup-faucet", b: "hsatm", label: "a grant or refusal is a signed message", trace: { section: 3, anchor: "opening, grant, or refusal produces a Household Signed Allowance Message" } },

  // Interior
  { a: "isp-counterparty", b: "common-fund", label: "commitments in, app payouts out", trace: { section: 2, anchor: "ISP commitments and debt repayments enter it, app payouts leave it" } },
  { a: "common-fund", b: "isp-commitment", label: "commitments enter the fund", trace: { section: 2, anchor: "ISP commitments and debt repayments enter it" } },
  { a: "isp-commitment", b: "base-and-topups", label: "commitments fund the guaranteed base", trace: { section: 2, anchor: "those commitments fund the households" } },
  { a: "isp-commitment", b: "the-pot", label: "the pot may exceed the commitments", trace: { section: 2, anchor: "The pot may be larger than the ISP" } },
  { a: "the-pot", b: "overdraft", label: "the excess is an overdraft limit", trace: { section: 2, anchor: "the difference is an overdraft limit backed by the common fund" } },
  { a: "common-fund", b: "overdraft", label: "overdraft backed by the common fund", trace: { section: 2, anchor: "overdraft limit backed by the common fund" } },
  { a: "the-pot", b: "base-and-topups", label: "allowances may never exceed the pot", trace: { section: 3, anchor: "the sum of all household allowances may never exceed it" } },
  { a: "the-pot", b: "isp-debt", label: "the pot itself creates no debt", trace: { section: 2, anchor: "Receiving or granting from the pot does not itself create ISP debt" } },
  { a: "overdraft", b: "isp-debt", label: "growing debt reduces overdraft capacity", trace: { section: 2, anchor: "growing or ageing debt reduces future overdraft capacity" } },
  { a: "isp-debt", b: "debt-update", label: "the debt is updated mechanically", trace: { section: 2, anchor: "debt is updated mechanically" } },
  { a: "isp-debt", b: "commitment-floor", label: "growing debt eventually requires larger commitments", trace: { section: 2, anchor: "requires larger commitments and explicit debt-service payments" } },
  { a: "commitment-floor", b: "isp-commitment", label: "structurally inadequate commitments raise the minimum", trace: { section: 2, anchor: "structurally inadequate commitments it raises the" } },
  { a: "funding-pressure", b: "isp-debt", label: "persistent debt requires larger commitments", trace: { section: 1, anchor: "persistent debt requires larger commitments and repayment" } },

  // Highlands
  { a: "hsatm", b: "box-hlaa", label: "the box account combines the total with signed consumption", trace: { section: 3, anchor: "combines that total with signed consumption to track the remaining balance" } },
  { a: "box-hlaa", b: "conrec", label: "declines to sign consumption beyond the total", trace: { section: 3, anchor: "declines to sign consumption beyond the authorized total" } },
  { a: "conrec", b: "price-catalogue", label: "each charge traces to the accepted catalogue", trace: { section: 4, anchor: "Each charge remains traceable to the accepted catalogue" } },
  { a: "app-set-prices", b: "price-catalogue", label: "a price rise takes effect next epoch (awaits incorporation)", trace: { section: 4, anchor: "app price increases take effect through a new catalogue and household acceptance in the next epoch" } },
  { a: "optimistic-serving", b: "fup-faucet", label: "serving while a top-up is pending", trace: { section: 4, anchor: "apps may provide services before final settlement or while a top-up is pending" } },
  { a: "optimistic-serving", b: "household-fraud", label: "serving apps absorb the shortfall", trace: { section: 4, anchor: "the serving apps collectively absorb the shortfall" } },
  { a: "conrec", b: "evidence-kept", label: "ConRecs stay off-chain in ordinary operation", trace: { section: 4, anchor: "Price agreements and fine-grained evidence remain off-chain during" } },
  { a: "conrec", b: "heid", label: "the household signs with its epoch key", trace: { section: 4, anchor: "the household signs with its epoch key" } },
  { a: "conrec", b: "rtgp", label: "ConRecs are the evidence behind each claim row", trace: { section: 4, anchor: "Every billable act produces a Consumption Record" } },
  { a: "evidence-kept", b: "evidence-round", label: "produced only when an audit or evidence round requires them", trace: { section: 6, anchor: "produce them only when an audit or evidence round requires them" } },
  { a: "evidence-kept", b: "ishec", label: "the diary is checked against the IsHEC", trace: { section: 5, anchor: "against its own diary" } },

  // Mountains
  { a: "heid", b: "hsatm", label: "the opening message binds the HEID to an allowance", trace: { section: 5, anchor: "The epoch-opening allowance message binds identity to entitlement" } },
  { a: "heid", b: "identity-layers", label: "the plaintext epoch ID is known to a few parties", trace: { section: 5, anchor: "the plaintext epoch ID is known to the household, ISP, and apps it used" } },
  { a: "identity-layers", b: "encrypted-heids", label: "only encrypted IDs go in ordinary public records", trace: { section: 5, anchor: "freshly randomized encryptions of that ID are the only form placed in ordinary public records" } },
  { a: "encrypted-heids", b: "rtgp", label: "each claim row carries a freshly encrypted ID", trace: { section: 6, anchor: "each row carries a freshly encrypted epoch ID" } },
  { a: "encrypted-heids", b: "reconcile-together", label: "the ISP decrypts and groups rows by household", trace: { section: 6, anchor: "it decrypts and groups every row by household" } },
  { a: "verification-tag", b: "ats", label: "only the ISP and the box can compute the tag", trace: { section: 5, anchor: "a rotating verification tag that only the ISP and the corresponding box can compute" } },
  { a: "verification-tag", b: "silent-padding", label: "apps cannot look up a customer's allowance", trace: { section: 5, anchor: "apps cannot compute the tag" } },
  { a: "ats", b: "heea", label: "the AtS partitions the pot into HEEAs", trace: { section: 6, anchor: "partitions the ISP's pot into household epoch escrow accounts" } },
  { a: "ats", b: "iptd", label: "payouts plus remainder equal the corrected closing total", trace: { section: 6, anchor: "payouts plus remainder must equal the corrected closing allowance total" } },
  { a: "ats", b: "hsatm", label: "HSATM is live in the epoch, the AtS is the baseline after", trace: { section: 6, anchor: "the highest-sequence HSATM is the authoritative allowance, while the AtS becomes the public settlement and arbitration baseline" } },
  { a: "ishec", b: "ats", label: "household checks both the IsHEC and the public allowance", trace: { section: 5, anchor: "compares the public closing allowance against its signed allowance messages" } },
  { a: "ishec", b: "silent-padding", label: "a lower diary total exposes the mismatch", trace: { section: 9, anchor: "lower diary total exposes the mismatch" } },

  // Deep valley
  { a: "hcd", b: "isp-commitment", label: "the ISP declares and funds its households", trace: { section: 6, anchor: "The ISP opens every epoch by declaring and funding its participating" } },
  { a: "rtgp", b: "reconcile-together", label: "the ISP reconciles every app's claim together", trace: { section: 6, anchor: "The ISP reconciles all apps together" } },
  { a: "rtgp", b: "epoch-timetable", label: "a late pilot claim is excluded and unpaid", trace: { section: 6, anchor: "excluded from that epoch and receives no payment" } },
  { a: "heea", b: "reconcile-together", label: "combined claims are compared with the escrow cap", trace: { section: 6, anchor: "compares each household's combined claims against its escrow cap" } },
  { a: "heea", b: "freeze-settle", label: "above the cap, every row stops", trace: { section: 6, anchor: "an aggregate above the cap stops every row for that household" } },
  { a: "heea", b: "the-pot", label: "an accounting container inside the pot", trace: { section: 6, anchor: "the underlying money remains inside the protocol-held ISP pot" } },
  { a: "reconcile-together", b: "iptd", label: "after privately grouping all rows by household", trace: { section: 6, anchor: "after privately grouping all RtgP rows by household" } },
  { a: "iptd", b: "freeze-settle", label: "flagged rows are published", trace: { section: 6, anchor: "its flagged rows" } },
  { a: "freeze-settle", b: "evidence-round", label: "an overrun opens an evidence round automatically", trace: { section: 6, anchor: "automatically opens an evidence round before any of those rows are paid" } },
  { a: "freeze-settle", b: "settlement-finality", label: "freezing normally avoids any clawback", trace: { section: 7, anchor: "paid in full without any clawback" } },
  { a: "epoch-timetable", b: "hcd", label: "each ISP posts one HCD per epoch", trace: { section: 8, anchor: "commitments, debt service, and pots precede serving" } },
  { a: "slashing-collateral", b: "debt-update", label: "unpaid debt service means collateral slashing", trace: { section: 6, anchor: "unpaid required debt service, or unfunded allowance correction" } },
  { a: "slashing-collateral", b: "escalation-audit", label: "collateral backs escalation audits", trace: { section: 8, anchor: "the collateral backs evidence duties, escalation audits, and slashing" } },
  { a: "slashing-collateral", b: "silent-padding", label: "disposable padding identities become uneconomic", trace: { section: 8, anchor: "to make disposable padding identities uneconomic" } },
  { a: "emergency-settlement", b: "iptd", label: "a missing IPtD invokes it", trace: { section: 6, anchor: "A missing pilot IPtD invokes emergency settlement" } },
  { a: "emergency-settlement", b: "pilot-operator", label: "apps reveal their HEIDs to the pilot operator", trace: { section: 6, anchor: "affected apps reveal their HEIDs to the pilot operator" } },

  // Badlands
  { a: "evidence-round", b: "mechanical-resolution", label: "resolution is designed to be mechanical, not discretionary", trace: { section: 7, anchor: "Resolution is designed to be mechanical rather than discretionary" } },
  { a: "mechanical-resolution", b: "escalation-audit", label: "a voided, slashed row escalates to a full audit of the app", trace: { section: 7, anchor: "the row is voided, the app is slashed" } },
  { a: "mechanical-resolution", b: "pilot-operator", label: "contested disbursements go to the second instance", trace: { section: 7, anchor: "goes to the second instance" } },
  { a: "escalation-audit", b: "silent-padding", label: "one proven false row widens the inquiry", trace: { section: 7, anchor: "one proven false row expands the inquiry" } },
  { a: "silent-padding", b: "heea", label: "padding stays below the household's cap", trace: { section: 9, anchor: "keeps the household" } },
  { a: "household-fraud", b: "heea", label: "the household escrow is divided pro rata", trace: { section: 7, anchor: "the household escrow is divided pro rata across the valid app claims" } },
  { a: "household-fraud", b: "verification-tag", label: "the box detects a shaved entry by its tag", trace: { section: 7, anchor: "the box detects a shaved entry through its verification tag" } },
  { a: "timing-states", b: "hsatm", label: "true order reconstructed from signed messages", trace: { section: 3, anchor: "so their true order can be reconstructed later" } },
  { a: "timing-states", b: "hoarding", label: "hoarding and spend-ahead are contractual violations", trace: { section: 3, anchor: "Hoarding and spend-ahead are contractual violations even if later events" } },
  { a: "timing-states", b: "box-hlaa", label: "a tampered box signs beyond the current total", trace: { section: 9, anchor: "a tampered box signs consumption beyond the current HSAT" } },
  { a: "hoarding", b: "fup-faucet", label: "it front-runs the ISP's top-up buffer", trace: { section: 9, anchor: "Allowance hoarding front-runs the ISP" } },
  { a: "hoarding", b: "fup-audit", label: "the private timing audit exposes early requests", trace: { section: 9, anchor: "the private timing audit exposes the early requests" } },
  { a: "fup-audit", b: "pilot-operator", label: "the box supplies its ConRecs to the pilot operator", trace: { section: 3, anchor: "the box supplies its retained ConRecs to the pilot operator" } },
  { a: "fup-audit", b: "ishec", label: "evidence must reconcile to the charged total", trace: { section: 3, anchor: "the evidence must reconcile to the ISP's charged total" } },
  { a: "pilot-operator", b: "iptd", label: "a contested IPtD goes to the second instance", trace: { section: 7, anchor: "contested IPtD goes to the second instance" } },

  // Dragons: every one is open, not ratified
  { a: "price-catalogue", b: "tariff-format", label: "still needs a format and evidence specification", trace: { section: 10, anchor: "Epoch tariff agreements still need a format and evidence specification" } },
  { a: "isp-debt", b: "credit-calibration", label: "debt ceilings and ageing are not calibrated", trace: { section: 10, anchor: "debt ceilings, debt ageing, collateral ratios, amortization schedules" } },
  { a: "verification-tag", b: "dishonest-isp", label: "tag-to-ciphertext substitution must still be tested", trace: { section: 10, anchor: "tag-to-ciphertext substitution" } },
  { a: "signed-refusal", b: "dishonest-isp", label: "dishonest refusals motivated by debt still need testing", trace: { section: 10, anchor: "dishonest refusals motivated by debt" } },
  { a: "silent-padding", b: "collusion-padding", label: "one silent-padding form is still undefeated", trace: { section: 10, anchor: "ISP-and-app collusion still has an undefeated silent-padding form" } },
  { a: "collusion-padding", b: "anti-collusion", label: "only candidates, not part of the ratified pilot", trace: { section: 10, anchor: "are designed to work together but are not part of the ratified pilot mechanism" } },
  { a: "anti-collusion", b: "evidence-round", label: "broadcast evidence summons is a candidate", trace: { section: 10, anchor: "broadcast evidence summons" } },
  { a: "overdraft", b: "borrow-and-default", label: "a wash app can turn an ISP overdraft into cash", trace: { section: 10, anchor: "a wash app can turn an ISP overdraft into cash" } },
  { a: "pilot-operator", b: "durable-second-instance", label: "a temporary institutional answer", trace: { section: 10, anchor: "the pilot operator is a temporary institutional answer" } },
  { a: "evidence-round", b: "durable-second-instance", label: "the ISP cannot judge disputes it is party to", trace: { section: 10, anchor: "disputes in which the ISP is a party cannot be judged by that ISP" } },
  { a: "settlement-finality", b: "finality-horizon", label: "executed payments are final in the pilot", trace: { section: 10, anchor: "the pilot makes executed payments final" } },
  { a: "household-fraud", b: "isp-fronting", label: "an option only: ISP pays apps in full, then recovers", trace: { section: 10, anchor: "paying apps in full and recovering from the household" } },
  { a: "emergency-settlement", b: "post-pilot-emergency", label: "the post-pilot equivalent remains undefined", trace: { section: 6, anchor: "the equivalent post-pilot recovery mechanism remains undefined" } },
];

/** @param {string} a @param {string} b */
export function edgeKey(a, b) {
  return a < b ? `${a}|${b}` : `${b}|${a}`;
}

/**
 * Lookup tables over a graph. The defaults are the shipped graph; tests pass their own.
 * @param {typeof ISLANDS} [islands]
 * @param {typeof EDGES} [edges]
 */
export function buildIndex(islands = ISLANDS, edges = EDGES) {
  const byId = new Map(islands.map((island) => [island.id, island]));
  const neighbours = new Map(islands.map((island) => [island.id, new Set()]));
  const edgesOf = new Map(islands.map((island) => [island.id, []]));
  const byKey = new Map();
  for (const edge of edges) {
    neighbours.get(edge.a)?.add(edge.b);
    neighbours.get(edge.b)?.add(edge.a);
    edgesOf.get(edge.a)?.push(edge);
    edgesOf.get(edge.b)?.push(edge);
    byKey.set(edgeKey(edge.a, edge.b), edge);
  }
  return { byId, neighbours, edgesOf, byKey };
}
