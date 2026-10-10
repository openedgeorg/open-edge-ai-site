/**
 * The Atlas concept graph: islands, paths and the regions they sit in.
 *
 * Every island and every path is traced to the notes allowance architecture summary (the local
 * draft brain, not company-approved). `trace` records only the SECTION of the summary that backs
 * the island or the path ("preamble" or 1 to 10). The verbatim quotations that prove it live in
 * tests/fixtures/atlas-trace.json, which is not served: this page never ships the summary text.
 * Tests join the two by island id and by edgeKey(a, b) and check each quotation against the brain.
 * The page shows island names, one-line teaser questions, short path labels and section numbers.
 *
 * Contested items carry `status: "contested"`. The open items of the summary carry `status:
 * "open"`: every bullet of section 10, plus the other places where the summary says a mechanism
 * is undefined, deferred, unsealed or unresolved. They are the designers' own open list, drawn as
 * dragons; they are not a roadmap and nothing in them is promised.
 *
 * Source revision: this graph is grounded in the summary revision embedded in the local draft
 * brain, knowledge/brain/local-draft-v3 (50,394 bytes, sha256
 * 61f8361d77db0657cdbb29132a5ebe6930d663d07ce01bc6157fda6ef1660c88).
 * Re-author it, and the fixture, against the next brain version once the notes change.
 */

export const VIEWBOX = { width: 1240, height: 780 };
export const START_ID = "internet-bill";
export const FIRST_SUGGESTION = "Who actually pays the apps I use?";
export const EDGE_DRAGON_CAPTION = "Unfinished. You will get here.";
export const OPEN_LABEL = "open, not ratified";
export const CONTESTED_LABEL = "awaits incorporation";
/** The full wording of the contested label, as the summary's own preamble puts it. */
export const CONTESTED_FULL_LABEL = "awaits incorporation into the authoritative design and message catalogue";

export const REGIONS = [
  { id: "coast", level: "L0", name: "The Coast", subtitle: "The promise", x: 74 },
  { id: "lowlands", level: "L1", name: "The Lowlands", subtitle: "Living with an allowance", x: 188 },
  { id: "interior", level: "L2", name: "The Interior", subtitle: "Money plumbing", x: 316 },
  { id: "highlands", level: "L3", name: "The Highlands", subtitle: "Signed facts", x: 428 },
  { id: "mountains", level: "L4", name: "The Mountains", subtitle: "Masks", x: 542 },
  { id: "valley", level: "L5", name: "The Deep Valley", subtitle: "Month-end machinery", x: 719 },
  { id: "badlands", level: "L6", name: "The Badlands", subtitle: "Disputes and attacks", x: 851 },
  { id: "dragons", level: "L7", name: "Here be dragons", subtitle: "Open, not ratified", x: 1075 },
];

export const ISLANDS = [
  // ---- L0 The Coast: the promise (section 1) ----
  {
    id: "isp-counterparty", name: "ISP as your counterparty", region: "coast", x: 117, y: 244,
    teaser: "Why do I pay my ISP instead of being billed by each app separately?",
    trace: [{ section: 1 }, { section: 1 }],
    terms: ["financial counterparty", "counterparty", "separate billing relationship", "apps earn through the protocol"],
  },
  {
    id: "app-set-prices", name: "Apps set their own prices", region: "coast", x: 80, y: 166,
    teaser: "Do apps share a fixed subscription pool, like on Spotify?",
    trace: [{ section: 1 }, { section: 1 }, { section: 1 }],
    terms: ["app-set prices", "apps set their own prices", "spotify", "fixed-pot sharing", "fixed subscription pool", "sets its tariff", "usage-based provider economics"],
  },
  {
    id: "internet-bill", name: "Your internet bill", region: "coast", x: 105, y: 322, start: true,
    teaser: "Does ESP change what I pay my ISP each month?",
    trace: [{ section: 1 }, { section: 3 }],
    terms: ["internet bill", "ISP bill", "monthly bill", "agreed plan price", "agreed monthly bill"],
  },
  {
    id: "standing-plan", name: "One standing plan", region: "coast", x: 73, y: 410,
    teaser: "What does a fixed monthly plan give me that separate purchases would not?",
    trace: [{ section: 1 }, { section: 1 }],
    terms: ["standing plan", "fixed monthly plan", "predictable access", "flat-rate"],
  },
  {
    id: "monthly-epochs", name: "Monthly epochs", region: "coast", x: 113, y: 105,
    teaser: "What happens during one ESP month?",
    trace: [{ section: 1 }, { section: 1 }],
    terms: ["monthly epoch", "ESP epoch", "settlement executes once"],
  },

  // ---- L1 The Lowlands: living with an allowance (sections 1, 3) ----
  {
    id: "funding-pressure", name: "Prices push on the ISP", region: "lowlands", x: 212, y: 305,
    teaser: "Can app price rises end up in my plan price?",
    trace: [{ section: 1 }, { section: 1 }, { section: 1 }],
    terms: ["funding pressure", "price pressure", "rising service costs", "future household plan prices"],
  },
  {
    id: "price-feedback", name: "Price feedback and analytics", region: "lowlands", x: 217, y: 187,
    teaser: "How would I notice that an app has become expensive?",
    trace: [{ section: 1 }, { section: 3 }, { section: 3 }],
    terms: ["price feedback", "economic feedback", "household user experience", "household analytics", "consumption by app", "tariff increases from increased usage"],
  },
  {
    id: "fup-faucet", name: "The FUP faucet", region: "lowlands", x: 239, y: 677,
    teaser: "Does a top-up request name an amount, and who sizes the grant?",
    trace: [{ section: 3 }, { section: 3 }, { section: 3 }],
    terms: ["FUP faucet", "allowance faucet", "fair-use policy", "faucet", "grant sizing", "tail-reserve rule"],
  },
  {
    id: "base-and-topups", name: "Base allowance and top-ups", region: "lowlands", x: 180, y: 554,
    teaser: "If I run out, can I ask for more?",
    trace: [{ section: 3 }, { section: 3 }],
    terms: ["base allowance", "guaranteed base", "fungible", "top-up"],
  },
  {
    id: "retail-contract", name: "The retail contract", region: "lowlands", x: 162, y: 383,
    teaser: "Who decides how big my allowance is?",
    trace: [{ section: 3 }, { section: 8 }],
    terms: ["subscriber contract", "retail contract", "retail promise", "retail relationship", "retail product design", "contractual maximum"],
  },
  {
    id: "signed-refusal", name: "A refusal leaves signed evidence", region: "lowlands", x: 162, y: 713,
    teaser: "What if my ISP refuses a top-up that my plan entitles me to?",
    trace: [{ section: 3 }, { section: 3 }],
    terms: ["signed refusal", "legitimate refusal", "refusal during a hot month"],
  },

  // ---- L2 The Interior: money plumbing (section 2) ----
  {
    id: "common-fund", name: "The common fund", region: "interior", x: 301, y: 269,
    teaser: "Where does the money for the apps actually sit?",
    trace: [{ section: 2 }, { section: 2 }, { section: 2 }],
    terms: ["common fund", "protocol-level fund", "liquid backing"],
  },
  {
    id: "isp-commitment", name: "ISP monthly commitment", region: "interior", x: 272, y: 440,
    teaser: "What does an ISP prepay each month, and does it set my allowance?",
    trace: [{ section: 2 }, { section: 2 }],
    terms: ["monthly commitment", "ISP commitment", "prepays", "aggregate commitment", "funding attribution"],
  },
  {
    id: "the-pot", name: "The pot", region: "interior", x: 305, y: 519,
    teaser: "What is the pot an ISP gets each month?",
    trace: [{ section: 2 }, { section: 2 }, { section: 3 }],
    terms: ["the pot", "monthly pot", "spending envelope", "spending authority", "hard ceiling", "solvency boundary", "pot ceiling"],
  },
  {
    id: "overdraft", name: "Overdraft", region: "interior", x: 356, y: 572,
    teaser: "Can the pot be bigger than what the ISP committed?",
    trace: [{ section: 2 }, { section: 2 }, { section: 2 }],
    terms: ["overdraft", "overdraft allocation"],
  },
  {
    id: "isp-debt", name: "Debt from executed consumption", region: "interior", x: 265, y: 599,
    note: "The debt-control rules and thresholds are unresolved",
    teaser: "When does an ISP actually owe the fund money?",
    trace: [{ section: 2 }, { section: 2 }, { section: 2 }],
    terms: ["executed consumption", "ISP debt", "ISP liability", "liability to the common fund", "temporal smoothing", "debt growth", "old debt", "temporary credit limit"],
  },
  {
    id: "debt-update", name: "The monthly debt update", region: "interior", x: 359, y: 643,
    teaser: "How is an ISP's debt recalculated after each month?",
    trace: [{ section: 2 }, { section: 2 }, { section: 2 }, { section: 2 }],
    terms: ["debt update", "debt-service payments", "capital account", "communal surplus", "correction funding", "opening debt", "closing debt", "updated mechanically"],
  },

  // ---- L3 The Highlands: signed facts (sections 3, 4) ----
  {
    id: "price-catalogue", name: "Epoch price catalogue", region: "highlands", x: 385, y: 116,
    status: "contested", label: "awaits incorporation",
    teaser: "How is an app's price meant to become binding for the month?",
    trace: [{ section: 4 }, { section: 4 }, { section: "preamble" }],
    terms: ["price catalogue", "accepted catalogue", "tariff agreement", "catalogue acceptance"],
  },
  {
    id: "conrec", name: "Consumption Record (ConRec)", region: "highlands", x: 394, y: 220,
    teaser: "What proves that I really used an app?",
    trace: [{ section: 4 }, { section: 4 }],
    terms: ["ConRec", "Consumption Record"],
  },
  {
    id: "optimistic-serving", name: "Optimistic serving", region: "highlands", x: 463, y: 298,
    teaser: "What risk does an app take by serving beyond my current allowance?",
    trace: [{ section: 4 }, { section: 4 }],
    terms: ["optimistic serving", "optimistic service", "optimistic credit", "risk of serving", "serve optimistically", "serves optimistically"],
  },
  {
    id: "evidence-kept", name: "Off-chain evidence in normal use", region: "highlands", x: 458, y: 373,
    note: "The exact retention period is deferred",
    teaser: "Where do the signed records live, and for how long?",
    trace: [{ section: 4 }, { section: 4 }, { section: 4 }, { section: 5 }],
    terms: ["off-chain evidence", "off-chain during ordinary operation", "evidence retention", "ConRec diary", "local diary", "retention period", "fine-grained evidence"],
  },
  {
    id: "hsatm", name: "HSATM: signed allowance message", region: "highlands", x: 466, y: 575,
    teaser: "Who signs my allowance, and what exactly do they sign?",
    trace: [{ section: 3 }, { section: 3 }, { section: 3 }],
    terms: ["HSATM", "HSAT", "Household Signed Allowance Message", "Household Signed Allowance Total", "signed allowance message", "highest-sequence"],
  },
  {
    id: "box-hlaa", name: "A normal box declines to sign", region: "highlands", x: 410, y: 451,
    teaser: "What does my box do when my allowance runs out?",
    trace: [{ section: 3 }, { section: 3 }, { section: 3 }],
    terms: ["HLAA", "declines to sign", "decline to sign", "declining to sign", "enforces the allowance locally", "household-local allowance account"],
  },

  // ---- L4 The Mountains: masks and epoch opening (sections 5, 6) ----
  {
    id: "heid", name: "Fresh key, fresh HEID", region: "mountains", x: 498, y: 220,
    teaser: "Does my household's ID stay the same from one month to the next?",
    trace: [{ section: 5 }, { section: 5 }],
    terms: ["HEID", "household epoch ID", "epoch ID", "epoch keypair", "epoch identity"],
  },
  {
    id: "epoch-opening", name: "Opening a household's epoch", region: "mountains", x: 610, y: 213,
    teaser: "In what order does an epoch open, and what if a household never activates?",
    trace: [{ section: 5 }, { section: 5 }, { section: 6 }],
    terms: ["epoch opening", "dependency order", "household activation", "zero allowance", "sequence-zero"],
  },
  {
    id: "hpc", name: "HPC: participation credential", region: "mountains", x: 606, y: 301,
    teaser: "How does an app check that a household is admitted for the epoch?",
    trace: [{ section: 5 }, { section: 5 }, { section: 5 }],
    terms: ["HPC", "Household Participation Credential", "participation credential", "admission proof"],
  },
  {
    id: "identity-layers", name: "Three layers of identity", region: "mountains", x: 501, y: 139,
    teaser: "Who can see who I am, and who can't?",
    trace: [{ section: 5 }, { section: 5 }, { section: 5 }],
    terms: ["three layers", "identity layers", "identity model", "per-app household aggregates", "resolve a public claim"],
  },
  {
    id: "encrypted-heids", name: "Encrypted HEIDs", region: "mountains", x: 584, y: 108,
    teaser: "Why can't two apps tell, from public claims, that they share a customer?",
    trace: [{ section: 5 }, { section: 5 }, { section: 5 }],
    terms: ["encrypted HEID", "encrypted epoch ID", "fresh encryption randomness", "unlinkable ciphertexts", "randomized encryption", "HEID encrypted"],
  },
  {
    id: "verification-tag", name: "The verification tag", region: "mountains", x: 610, y: 560,
    teaser: "How can I find my own entry in a public list?",
    trace: [{ section: 5 }, { section: 5 }, { section: 5 }, { section: 7 }],
    terms: ["verification tag", "verification secret", "one-way tag", "allowance lookup", "tag-to-ciphertext", "binding digest", "shaved entry", "shaved amount"],
  },
  {
    id: "ats", name: "Allowance to Spend (AtS)", region: "mountains", x: 521, y: 471,
    teaser: "What is the public list of closing allowances?",
    trace: [{ section: 5 }, { section: 6 }, { section: 6 }],
    terms: ["AtS", "Allowance to Spend", "closing allowance list", "closing report", "live spending oracle"],
  },
  {
    id: "ishec", name: "IsHEC against your diary", region: "mountains", x: 581, y: 392,
    note: "The route for demanding a missing IsHEC is unresolved",
    teaser: "How do I check what my ISP says I consumed?",
    trace: [{ section: 5 }, { section: 5 }],
    terms: ["IsHEC", "Household Epoch Consumption", "charged total", "private signed total"],
  },

  // ---- L5 The Deep Valley: month-end machinery and roles (sections 6, 8) ----
  {
    id: "epoch-timetable", name: "The epoch timetable", region: "valley", x: 763, y: 97,
    teaser: "In what order does a month's machinery run?",
    trace: [{ section: 8 }, { section: 6 }, { section: 8 }, { section: 8 }],
    terms: ["epoch timetable", "precedes the challenge window", "claim deadline", "hard deadline", "blockchain load", "epoch footprint"],
  },
  {
    id: "hcd", name: "The HCD: the ISP's household roster", region: "valley", x: 749, y: 185,
    note: "The roster is trusted, not verified; a revision may reconsider",
    teaser: "How does an ISP open a month, and who vouches for its household list?",
    trace: [{ section: 6 }, { section: 6 }, { section: 8 }],
    terms: ["HCD", "Household Commitment Declaration", "roster membership", "roster authenticity", "ISP trust boundary"],
  },
  {
    id: "rtgp", name: "Request to get Paid (RtgP)", region: "valley", x: 667, y: 135,
    teaser: "How does an app get paid for a month of requests?",
    trace: [{ section: 6 }, { section: 6 }],
    terms: ["RtgP", "Request to get Paid", "monthly claim", "ISP subtotals"],
  },
  {
    id: "reconcile-together", name: "Reconciling all claims together", region: "valley", x: 654, y: 438,
    teaser: "Does the first app to claim get first dibs on my allowance?",
    trace: [{ section: 6 }, { section: 6 }],
    terms: ["reconciles all accepted", "arrival order", "all claims together", "combined claims"],
  },
  {
    id: "heea", name: "HEEA: epoch escrow account", region: "valley", x: 740, y: 394,
    teaser: "What caps what can be paid for one household?",
    trace: [{ section: 6 }, { section: 6 }],
    terms: ["HEEA", "household epoch escrow account", "escrow account", "escrow cap", "accounting container"],
  },
  {
    id: "iptd", name: "The IPtD: proposed payouts", region: "valley", x: 698, y: 516,
    teaser: "What does the ISP publish about who gets paid?",
    trace: [{ section: 6 }, { section: 6 }, { section: 6 }],
    terms: ["IPtD", "disbursement plan", "settlement outcomes", "public verification", "proposed payout", "gross evidence", "nets money", "one epoch payment per app"],
  },
  {
    id: "freeze-settle", name: "Settle clean, freeze flagged", region: "valley", x: 772, y: 472,
    teaser: "What happens when a household's claims exceed its cap?",
    trace: [{ section: 6 }, { section: 6 }, { section: 7 }],
    terms: ["the freeze", "flagged households", "flagged household", "clean households", "freezing an overrun", "overrun flag", "stops every row", "rows are frozen", "claims are frozen"],
  },
  {
    id: "isp-epoch-failure", name: "When an ISP fails its epoch", region: "valley", x: 686, y: 654,
    note: "Slashing and wind-down are intended; the machinery is deferred",
    teaser: "What happens if an ISP does not fund or close its epoch?",
    trace: [{ section: 6 }, { section: 6 }, { section: 6 }],
    terms: ["establishes an ISP default", "missed AtS", "no participating epoch", "forced wind-down", "unpaid required debt service", "unfunded allowance correction"],
  },
  {
    id: "who-does-what", name: "Who does what: box, ISP, apps", region: "valley", x: 732, y: 281,
    teaser: "What do the box, the ISP and the apps each do, and what is the ISP trusted with?",
    trace: [{ section: 8 }, { section: 8 }, { section: 8 }],
    terms: ["household box is an observer", "payment discretion", "evidence custodians", "private mapping"],
  },

  // ---- L6 The Badlands: disputes and attacks (sections 3, 7, 9) ----
  {
    id: "evidence-round", name: "Evidence rounds and the CfEfA", region: "badlands", x: 852, y: 307,
    note: "The household-report route is unresolved; penalties are deferred",
    teaser: "What triggers a dispute, and what gets made public?",
    trace: [{ section: 7 }, { section: 7 }, { section: 7 }, { section: 7 }],
    terms: ["evidence round", "CfEfA", "Call for Evidence", "posted in plaintext", "bounded public proceeding", "epoch basket"],
  },
  {
    id: "mechanical-resolution", name: "Mechanical resolution", region: "badlands", x: 944, y: 157,
    note: "The ISP's witness list is trusted to be complete",
    teaser: "Is a dispute meant to be settled by arithmetic, and who lists the apps?",
    trace: [{ section: 7 }, { section: 7 }, { section: 7 }],
    terms: ["mechanical resolution", "mechanical rather than discretionary", "signed denial", "witness list", "self-correcting", "false inclusion"],
  },
  {
    id: "escalation-audit", name: "Unsupported row, escalation audit", region: "badlands", x: 936, y: 416,
    note: "The audit mechanism itself is deferred",
    teaser: "What happens to an app whose row has no supporting evidence?",
    trace: [{ section: 7 }, { section: 7 }, { section: 7 }],
    terms: ["escalation audit", "unsupported row", "app fraud", "missed evidence duty", "fabricated the row"],
  },
  {
    id: "silent-padding", name: "Silent padding", region: "badlands", x: 861, y: 385,
    note: "One collusion form is still undefeated",
    teaser: "How could an app invent charges that stay under my cap?",
    trace: [{ section: 9 }, { section: 7 }, { section: 9 }],
    terms: ["silent padding", "fabricated app charge"],
  },
  {
    id: "household-fraud", name: "Household fraud: the pro-rata split", region: "badlands", x: 871, y: 229,
    teaser: "What if a household really consumed more than its closing allowance?",
    trace: [{ section: 7 }, { section: 7 }, { section: 7 }],
    terms: ["household fraud", "pro-rata haircuts", "divided pro rata", "pro-rata allocation", "absorb the shortfall", "absorb the remaining shortfall"],
  },
  {
    id: "allowance-correction", name: "Correcting a false closing entry", region: "badlands", x: 798, y: 560,
    note: "How a household's challenge reaches the protocol is unsealed",
    teaser: "What if the closing allowance listed for a household is wrong?",
    trace: [{ section: 7 }, { section: 7 }],
    terms: ["false closing entry", "allowance correction", "honest household"],
  },
  {
    id: "timing-states", name: "Two timing states", region: "badlands", x: 900, y: 609,
    note: "Invocation, proofs and result record are deferred",
    teaser: "What counts as compliant consumption, and what counts as spend-ahead?",
    trace: [{ section: 3 }, { section: 3 }, { section: 9 }, { section: 3 }, { section: 3 }],
    terms: ["timing states", "timing audit", "ex-post audit", "spend-ahead", "FUP audit", "compliant consumption", "signing order"],
  },
  {
    id: "hoarding", name: "Hoarding", region: "badlands", x: 799, y: 679,
    note: "The audit that would establish it is deferred",
    teaser: "Why is asking for a top-up far ahead of need a violation?",
    trace: [{ section: 9 }, { section: 3 }, { section: 9 }],
    terms: ["hoarding", "internal grant allocation"],
  },
  {
    id: "detection-posture", name: "Detection plus consequences", region: "badlands", x: 873, y: 516,
    note: "The penalties are intended; their enforcement is deferred",
    teaser: "Does ESP stop fraud as it happens, or catch it afterwards?",
    trace: [{ section: 7 }, { section: 7 }],
    terms: ["detection plus consequences", "real-time prevention", "interim exposure", "unattractive repeated strategy"],
  },

  // ---- L7 Here be dragons: open, not ratified (section 10, and the other open items of sections 2 to 8) ----
  {
    id: "epoch-opening-handoff", name: "Epoch-opening handoff mechanics", region: "dragons", x: 1158, y: 66,
    status: "open", label: "open, not ratified",
    teaser: "Which epoch-opening handoff mechanics are still unspecified?",
    trace: [{ section: 10 }, { section: 5 }],
    terms: ["epoch-opening handoff", "handoff mechanics", "bilateral transport"],
  },
  {
    id: "ats-binding-challenge", name: "AtS-binding challenge route", region: "dragons", x: 1148, y: 600,
    status: "open", label: "open, not ratified",
    teaser: "Which parts of the AtS-binding challenge are still unspecified?",
    trace: [{ section: 10 }, { section: 10 }],
    terms: ["AtS-binding challenge", "binding challenge"],
  },
  {
    id: "pre-activation-conrec", name: "Pre-activation ConRec enforcement", region: "dragons", x: 1066, y: 125,
    status: "open", label: "open, not ratified",
    teaser: "Can anyone prove an app checked the HPC before serving?",
    trace: [{ section: 10 }, { section: 5 }],
    terms: ["pre-activation", "mandatory HPC check", "credential-to-consumption binding", "admission preceded"],
  },
  {
    id: "tariff-format", name: "Tariff-agreement format", region: "dragons", x: 976, y: 64,
    status: "open", label: "open, not ratified",
    teaser: "What is still unspecified about tariff agreements?",
    trace: [{ section: 10 }],
    terms: ["tariff-agreement format", "format and evidence specification", "catalogue identifiers", "acceptance binding"],
  },
  {
    id: "credit-calibration", name: "Credit policy and debt control", region: "dragons", x: 1164, y: 701,
    status: "open", label: "open, not ratified",
    teaser: "Which credit-policy numbers and debt-control rules are still undecided?",
    trace: [{ section: 10 }, { section: 2 }, { section: 2 }],
    terms: ["credit policy", "debt ceilings", "debt ageing", "collateral ratios", "amortization schedules", "default waterfall", "numerical calibration", "debt-control rules"],
  },
  {
    id: "dishonest-isp", name: "Dishonest-ISP analysis", region: "dragons", x: 976, y: 703,
    status: "open", label: "open, not ratified",
    teaser: "Which dishonest-ISP cases must the design still test?",
    trace: [{ section: 10 }],
    terms: ["dishonest-ISP analysis", "allowance shaving", "dishonest refusals", "correction-funding failure"],
  },
  {
    id: "collusion-padding", name: "ISP-and-app collusion", region: "dragons", x: 1172, y: 409,
    status: "open", label: "open, not ratified",
    teaser: "Is there a silent-padding form the current design does not defeat?",
    trace: [{ section: 10 }],
    terms: ["ISP-and-app collusion", "undefeated silent-padding", "accomplice app"],
  },
  {
    id: "anti-collusion", name: "Anti-collusion candidates", region: "dragons", x: 1174, y: 194,
    status: "open", label: "open, not ratified",
    teaser: "Which anti-collusion ideas are only candidates so far?",
    trace: [{ section: 10 }],
    terms: ["anti-collusion", "charged-total annex", "trustless witness discovery", "broadcast evidence summons", "compelled verifiable decryption", "random evidence sampling"],
  },
  {
    id: "borrow-and-default", name: "Borrow-and-default", region: "dragons", x: 1069, y: 659,
    status: "open", label: "open, not ratified",
    teaser: "When would turning an ISP overdraft into cash pay off?",
    trace: [{ section: 10 }],
    terms: ["borrow-and-default", "wash app", "allocation farming"],
  },
  {
    id: "durable-second-instance", name: "A durable second instance", region: "dragons", x: 976, y: 277,
    status: "open", label: "open, not ratified",
    teaser: "Who judges a dispute in which the ISP is a party?",
    trace: [{ section: 10 }, { section: 8 }],
    terms: ["durable second instance", "independent dispute resolution", "independent actor or mechanism"],
  },
  {
    id: "finality-horizon", name: "Finality and post-execution recovery", region: "dragons", x: 1057, y: 350,
    status: "open", label: "open, not ratified",
    teaser: "When does a payment become irreversible, and what if fraud shows up later?",
    trace: [{ section: 10 }, { section: 6 }, { section: 4 }],
    terms: ["settlement finality", "irreversibility horizon", "post-execution recovery", "payment reversal"],
  },
  {
    id: "penalty-enforcement", name: "Penalty enforcement", region: "dragons", x: 1024, y: 465,
    status: "open", label: "open, not ratified",
    teaser: "Which penalty rules behind slashing and expulsion are still undefined?",
    trace: [{ section: 10 }, { section: 6 }, { section: 7 }, { section: 8 }],
    terms: ["penalty enforcement", "collateral slashing", "slashing and expulsion", "slashing or expulsion", "slashing and possible expulsion", "possible expulsion", "registration collateral", "collateral sizing"],
  },
  {
    id: "isp-fronting", name: "ISP fronting of shortfalls", region: "dragons", x: 1054, y: 218,
    status: "open", label: "open, not ratified",
    note: "Pro-rata is the standing rule; fronting is not in the current path",
    teaser: "Could the ISP pay apps in full and recover from the household?",
    trace: [{ section: 10 }],
    terms: ["ISP fronting", "fronting of household shortfalls", "obligatory insurer"],
  },
  {
    id: "emergency-settlement", name: "Emergency settlement route", region: "dragons", x: 994, y: 542,
    status: "open", label: "open, not ratified",
    teaser: "What happens if the ISP misses the IPtD deadline?",
    trace: [{ section: 6 }, { section: 6 }, { section: 8 }],
    terms: ["emergency settlement", "emergency-settlement route", "missing IPtD", "claim assignments"],
  },
  {
    id: "household-routes", name: "Household-facing routes", region: "dragons", x: 1147, y: 291,
    status: "open", label: "open, not ratified",
    teaser: "Which household-facing routes does the design leave undefined?",
    trace: [{ section: 8 }, { section: 7 }, { section: 5 }, { section: 2 }, { section: 8 }],
    terms: ["household ingress", "household-to-protocol challenge", "household-report route", "household transparency", "production-demand", "exceptional evidence submission"],
  },
  {
    id: "audit-design", name: "Audit mechanisms not yet designed", region: "dragons", x: 1154, y: 507,
    status: "open", label: "open, not ratified",
    teaser: "What is still undecided about the FUP and escalation audits?",
    trace: [{ section: 3 }, { section: 3 }, { section: 7 }],
    terms: ["zero-knowledge", "ZK", "proof relation", "completeness guarantee", "fallback disclosure", "invocation route", "proof duties", "deferred audit design"],
  },
];

export const EDGES = [
  // Coast
  { a: "internet-bill", b: "isp-counterparty", label: "the ISP is paid by the household under one standing plan", trace: { section: 1 } },
  { a: "internet-bill", b: "standing-plan", label: "one plan avoids a separate household bill per online act", trace: { section: 1 } },
  { a: "standing-plan", b: "app-set-prices", label: "the allowance reconciles flat-rate use with usage-based pay", trace: { section: 1 } },
  { a: "monthly-epochs", b: "app-set-prices", label: "new prices need acceptance next epoch (awaits incorporation)", trace: { section: 4 } },

  // Paths reaching the Lowlands
  { a: "internet-bill", b: "retail-contract", label: "the household's bill stays bounded by its retail contract", trace: { section: 3 } },
  { a: "internet-bill", b: "funding-pressure", label: "higher app prices do not automatically raise the bill", trace: { section: 1 } },
  { a: "standing-plan", b: "base-and-topups", label: "the plan sets the base allowance and top-up entitlements", trace: { section: 3 } },
  { a: "app-set-prices", b: "funding-pressure", label: "higher app prices can push payouts past ISP contributions", trace: { section: 1 } },
  { a: "app-set-prices", b: "price-feedback", label: "higher app prices consume allowance faster", trace: { section: 1 } },
  { a: "price-feedback", b: "fup-faucet", label: "FUP limits on further grants can interrupt expected app use", trace: { section: 3 } },
  { a: "base-and-topups", b: "retail-contract", label: "the base allowance is defined by the retail relationship", trace: { section: 3 } },
  { a: "base-and-topups", b: "fup-faucet", label: "a top-up request carries no amount; the ISP sizes the grant", trace: { section: 3 } },
  { a: "base-and-topups", b: "signed-refusal", label: "a refusal is legitimate only if it follows the FUP and pot", trace: { section: 3 } },

  // Paths reaching the Interior
  { a: "isp-counterparty", b: "common-fund", label: "ISP commitments flow into the fund, app payouts flow out", trace: { section: 2 } },
  { a: "base-and-topups", b: "the-pot", label: "household allowances may never sum to more than the pot", trace: { section: 3 } },
  { a: "funding-pressure", b: "isp-debt", label: "debt may press future plan prices; control rules unresolved", trace: { section: 1 } },
  { a: "common-fund", b: "isp-commitment", label: "commitments and debt repayments enter the common fund", trace: { section: 2 } },
  { a: "isp-commitment", b: "the-pot", label: "the pot can exceed the ISP's commitments", trace: { section: 2 } },
  { a: "the-pot", b: "overdraft", label: "the part of the pot above commitments is the overdraft", trace: { section: 2 } },
  { a: "common-fund", b: "overdraft", label: "the overdraft is common-fund capacity reserved for the ISP", trace: { section: 2 } },
  { a: "overdraft", b: "isp-debt", label: "growing or ageing debt shrinks later overdraft (rules open)", trace: { section: 2 } },
  { a: "isp-debt", b: "debt-update", label: "the ISP's debt follows a mechanical update rule", trace: { section: 2 } },
  { a: "isp-debt", b: "isp-commitment", label: "debt-control rules may raise commitments but are unresolved", trace: { section: 2 } },

  // Paths reaching the Highlands
  { a: "fup-faucet", b: "hsatm", label: "a grant or refusal produces a signed allowance message", trace: { section: 3 } },
  { a: "hsatm", b: "box-hlaa", label: "the box's account combines the signed total with consumption", trace: { section: 3 } },
  { a: "box-hlaa", b: "conrec", label: "a normal box declines to sign consumption beyond the total", trace: { section: 3 } },
  { a: "conrec", b: "price-catalogue", label: "charges trace to the catalogue, which awaits incorporation", trace: { section: 4 } },
  { a: "app-set-prices", b: "price-catalogue", label: "each app's signed price catalogue (awaits incorporation)", trace: { section: 4 } },
  { a: "conrec", b: "evidence-kept", label: "apps keep the ConRecs they need to prove their claims", trace: { section: 4 } },
  { a: "optimistic-serving", b: "conrec", label: "apps may risk serving on a signed ConRec past the allowance", trace: { section: 4 } },

  // Paths reaching the Mountains
  { a: "hsatm", b: "heid", label: "the opening HSATM binds allowance state to the HEID", trace: { section: 5 } },
  { a: "hsatm", b: "ats", label: "the HSATM is live; the AtS is the baseline after the epoch", trace: { section: 6 } },
  { a: "heid", b: "identity-layers", label: "the plaintext HEID is known to household, ISP and used apps", trace: { section: 5 } },
  { a: "identity-layers", b: "encrypted-heids", label: "only freshly encrypted IDs go into ordinary public records", trace: { section: 5 } },
  { a: "verification-tag", b: "ats", label: "only the ISP and the household's own box can compute the tag", trace: { section: 5 } },
  { a: "ishec", b: "ats", label: "a household checks both the AtS entry and the IsHEC", trace: { section: 5 } },
  { a: "epoch-opening", b: "heid", label: "epoch opening begins with the fresh HEID and control proof", trace: { section: 5 } },
  { a: "epoch-opening", b: "hpc", label: "the HPC must be issued before the first ESP-billable service", trace: { section: 5 } },
  { a: "ats", b: "epoch-opening", label: "no effective opening HSATM means a zero AtS entry", trace: { section: 6 } },

  // Paths reaching the Deep Valley
  { a: "conrec", b: "rtgp", label: "apps and boxes retain the signed ConRecs behind RtgP rows", trace: { section: 6 } },
  { a: "encrypted-heids", b: "rtgp", label: "each RtgP row carries a freshly encrypted epoch ID", trace: { section: 6 } },
  { a: "ats", b: "heea", label: "the AtS partitions the pot into HEEAs", trace: { section: 6 } },
  { a: "epoch-opening", b: "hcd", label: "HCD acceptance precedes pot activation and the opening HSATM", trace: { section: 6 } },
  { a: "epoch-timetable", b: "hcd", label: "an ISP posts one HCD per epoch", trace: { section: 8 } },
  { a: "hcd", b: "isp-commitment", label: "HCD attributions sum to the aggregate monthly commitment", trace: { section: 6 } },
  { a: "hcd", b: "hpc", label: "each HPC maps to one HCD entry, on the ISP's declaration", trace: { section: 6 } },
  { a: "monthly-epochs", b: "epoch-timetable", label: "commitments and pots come before serving each month", trace: { section: 8 } },
  { a: "rtgp", b: "epoch-timetable", label: "a late RtgP is rejected and excluded from that epoch", trace: { section: 6 } },
  { a: "rtgp", b: "reconcile-together", label: "the ISP reconciles all accepted RtgP claims together", trace: { section: 6 } },
  { a: "heea", b: "reconcile-together", label: "combined claims are compared with the escrow cap", trace: { section: 6 } },
  { a: "heea", b: "freeze-settle", label: "a household's aggregate over its HEEA cap stops all its rows", trace: { section: 6 } },
  { a: "reconcile-together", b: "iptd", label: "the IPtD follows private grouping of all rows by household", trace: { section: 6 } },
  { a: "iptd", b: "freeze-settle", label: "the IPtD publishes proposed payouts and flagged rows", trace: { section: 6 } },
  { a: "isp-epoch-failure", b: "isp-commitment", label: "an unfunded ISP commitment means no participating epoch", trace: { section: 6 } },
  { a: "isp-epoch-failure", b: "debt-update", label: "unpaid required debt service establishes an ISP default", trace: { section: 6 } },
  { a: "who-does-what", b: "box-hlaa", label: "the box observes and never has to post routine transactions", trace: { section: 8 } },
  { a: "who-does-what", b: "evidence-kept", label: "apps both serve households and keep the evidence", trace: { section: 8 } },

  // Paths reaching the Badlands
  { a: "optimistic-serving", b: "household-fraud", label: "serving apps absorb the shortfall of their optimistic credit", trace: { section: 7 } },
  { a: "evidence-kept", b: "evidence-round", label: "apps disclose retained records when a CfEfA requires them", trace: { section: 6 } },
  { a: "verification-tag", b: "silent-padding", label: "tags and encrypted HEIDs deny apps an allowance lookup", trace: { section: 9 } },
  { a: "ishec", b: "silent-padding", label: "a lower diary exposes IsHEC padding unless the ISP colludes", trace: { section: 9 } },
  { a: "freeze-settle", b: "evidence-round", label: "an overrun opens an evidence round automatically", trace: { section: 6 } },
  { a: "evidence-round", b: "mechanical-resolution", label: "resolution is designed to be mechanical, not discretionary", trace: { section: 7 } },
  { a: "escalation-audit", b: "silent-padding", label: "one proven false row widens the inquiry to the whole app", trace: { section: 7 } },
  { a: "timing-states", b: "hoarding", label: "hoarding and spend-ahead are contractual violations", trace: { section: 3 } },
  { a: "timing-states", b: "hsatm", label: "timestamps give an asserted order of HSATMs and consumption", trace: { section: 3 } },
  { a: "hoarding", b: "fup-faucet", label: "hoarding can skew how an ISP allocates grants internally", trace: { section: 9 } },
  { a: "silent-padding", b: "heea", label: "padding stays under the HEEA, so no overrun fires", trace: { section: 9 } },
  { a: "household-fraud", b: "heea", label: "valid claims past the cap share the HEEA in proportion", trace: { section: 7 } },
  { a: "allowance-correction", b: "verification-tag", label: "a box detects a shaved closing entry through its tag", trace: { section: 7 } },
  { a: "allowance-correction", b: "ats", label: "signed evidence sets the baseline for a wrong AtS entry", trace: { section: 7 } },
  { a: "detection-posture", b: "freeze-settle", label: "freezing an overrun normally stops fraudulent payouts", trace: { section: 7 } },
  { a: "detection-posture", b: "penalty-enforcement", label: "penalties are intended; their enforcement is still open", trace: { section: 7 } },

  // Dragons: every one is open, not ratified
  { a: "epoch-opening", b: "epoch-opening-handoff", label: "opening-step transport, timeout and retry: still open", trace: { section: 10 } },
  { a: "heid", b: "epoch-opening-handoff", label: "the HEID control-proof transport is still open", trace: { section: 5 } },
  { a: "verification-tag", b: "ats-binding-challenge", label: "tag-swap evidence is defined; its challenge route is open", trace: { section: 10 } },
  { a: "hpc", b: "pre-activation-conrec", label: "admission before a ConRec is unproven; still open", trace: { section: 5 } },
  { a: "price-catalogue", b: "tariff-format", label: "catalogue identifiers and acceptance binding: still open", trace: { section: 10 } },
  { a: "signed-refusal", b: "dishonest-isp", label: "dishonest refusals motivated by debt: analysis still open", trace: { section: 10 } },
  { a: "silent-padding", b: "collusion-padding", label: "one silent-padding form is still undefeated and open", trace: { section: 10 } },
  { a: "collusion-padding", b: "anti-collusion", label: "anti-collusion ideas are candidates only; still open", trace: { section: 10 } },
  { a: "overdraft", b: "borrow-and-default", label: "wash-app cash-out pays only if the ISP evades debt; open", trace: { section: 10 } },
  { a: "evidence-round", b: "durable-second-instance", label: "disputes with the ISP as a party: the judge is still open", trace: { section: 10 } },
  { a: "who-does-what", b: "durable-second-instance", label: "who decides a dispute involving an ISP is still open", trace: { section: 8 } },
  { a: "freeze-settle", b: "finality-horizon", label: "when executed payments become final is still open", trace: { section: 6 } },
  { a: "isp-epoch-failure", b: "penalty-enforcement", label: "slashing and wind-down are intended, machinery still open", trace: { section: 6 } },
  { a: "escalation-audit", b: "penalty-enforcement", label: "missed duties and fraud enter penalty enforcement: open", trace: { section: 7 } },
  { a: "household-fraud", b: "isp-fronting", label: "pro-rata is the current rule; ISP fronting is not ratified", trace: { section: 10 } },
  { a: "iptd", b: "emergency-settlement", label: "a missing IPtD needs an emergency route that is still open", trace: { section: 6 } },
  { a: "isp-epoch-failure", b: "emergency-settlement", label: "missing the IPtD deadline is an ISP violation; route open", trace: { section: 6 } },
  { a: "ishec", b: "household-routes", label: "IsHEC production-demand and escalation routes: still open", trace: { section: 5 } },
  { a: "evidence-round", b: "household-routes", label: "household diary mismatches use a report route still open", trace: { section: 7 } },
  { a: "hcd", b: "household-routes", label: "household visibility of its HCD attribution is still open", trace: { section: 6 } },
  { a: "allowance-correction", b: "household-routes", label: "household challenge route to the protocol: still open", trace: { section: 7 } },
  { a: "timing-states", b: "audit-design", label: "FUP audit invocation and result record: still open", trace: { section: 3 } },
  { a: "escalation-audit", b: "audit-design", label: "escalation audit mechanism and proof duties: still open", trace: { section: 7 } },
  { a: "credit-calibration", b: "isp-debt", label: "debt-control formula, thresholds and epochs: TODO, open", trace: { section: 2 } },
  { a: "escalation-audit", b: "finality-horizon", label: "consequences of a conviction for an executed epoch: open", trace: { section: 7 } },
  { a: "evidence-kept", b: "finality-horizon", label: "retention period is deferred with finality: still open", trace: { section: 4 } },
  { a: "finality-horizon", b: "ishec", label: "a mismatch found only after execution: remedy still open", trace: { section: 5 } },
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
