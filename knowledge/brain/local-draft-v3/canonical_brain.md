INITIAL LOCAL BRAIN. NOT A COMPANY-APPROVED CANONICAL BRAIN.

Release id: local-draft-brain-v3
Label: initial local brain
Source path: /home/ibmko/lab/oe/materials/Whitepaper/v0.2/notes-allowance-architecture-summary.md
Status of this text: draft, for the local compose listener only

The bytes between the BEGIN SOURCE and END SOURCE markers are the source file, verbatim. This header is a local label. It is not part of the source notes and it does not add facts about ESP. This file is not a company-approved canonical brain.

----- BEGIN SOURCE /home/ibmko/lab/oe/materials/Whitepaper/v0.2/notes-allowance-architecture-summary.md -----
# ESP allowance and clearing architecture — bullet summary

Status: explanatory summary drafted on 2026-09-02 from
`notes-allowance-design-revisited.md`. The revisited design remains the
authoritative specification. This document describes its economic and clearing
architecture in large, self-contained bullets; it does not cover the wider ESP
ambitions around data commons or edge computing. Unfinished production work is
identified explicitly in the final section.

The epoch price-catalogue mechanism in section 4 awaits incorporation into the
authoritative design and message catalogue.

## 1. Purpose and economic product

- **ESP makes the ISP the household's financial counterparty for participating
  Internet services:** the household pays its ISP under one standing plan, while
  apps earn through the protocol instead of establishing a separate billing
  relationship with every household.

- **The household buys predictable access rather than a sequence of isolated
  purchases:** a fixed monthly plan finances general spending capacity, allowing
  light and heavy usage to vary without turning every online act into a separate
  household bill.

- **ESP must compensate for the price feedback weakened by flat-rate access:**
  the household chooses services while its immediate bill remains unchanged,
  separating consumption decisions from their funding consequences; the
  architecture therefore needs mechanisms that help households respond to app
  prices and ensure that ISPs repay the credit used to fund their households’
  consumption.

- **ESP chooses user experience as the household’s immediate economic feedback:**
  metered billing makes higher app prices felt through a higher bill; ESP keeps
  the agreed monthly bill predictable while higher prices consume allowance
  faster and can limit expected app use under FUP. The intended signal is a
  worse service experience that households can trace to costly apps and respond
  to by changing their usage.

- **ESP explicitly chooses app-set prices over Spotify-style fixed-pot
  sharing:** each app sets its tariff, and evidenced consumption at accepted
  prices determines its claim; revenue is not a share of a fixed subscription
  pool, while pro-rata haircuts remain an exceptional allowance-overrun remedy.

- **App prices transmit rising service costs into ISP funding pressure:** if
  households keep consuming at higher accepted prices, payouts within funded
  allowances can exceed ISP contributions and create debt; persistent debt
  requires larger commitments and repayment, putting pressure on the ISP to
  raise future household plan prices.

- **Price pressure does not bypass retail or funding limits:** higher app
  prices may exhaust allowances sooner, but do not automatically enlarge the
  pot, authorize top-ups, or increase a household's bill; the ISP chooses how
  funding requirements affect its margins and future plans.

- **The allowance reconciles flat-rate experience with usage-based provider
  economics:** the household experiences one general service envelope, while
  accepted app prices determine how that finite purchasing capacity is consumed
  and how revenue is distributed among apps.

- **The architecture runs in monthly epochs:** commitments and pots are
  established before serving, consumption accumulates during the month, claims
  and allowances close together, disputes resolve inside a defined window, and
  settlement executes once.

## 2. Common fund, pot, and ISP capital account

- **ESP operates one common protocol-level fund:** ISP commitments and debt
  repayments enter it, app payouts leave it, and all unused money remains
  communal.

- **Each ISP prepays a monthly commitment for every participating household:**
  those commitments fund the households’ guaranteed base allowances.

- **The protocol assigns each ISP a monthly pot:** the pot is a protocol-held
  spending envelope and the hard ceiling on the total allowances the ISP may
  authorize.

- **The pot may be larger than the ISP’s commitments:** the difference is an
  overdraft limit backed by the common fund.

- **Receiving or granting from the pot does not itself create ISP debt:** the
  pot is spending authority, not money transferred to the ISP.

- **Debt arises only from executed consumption:** if apps are actually paid more
  than the ISP funded, the difference becomes an ISP liability to the common
  fund.

- **Debt preserves financial accountability while allowing temporary support:**
  the protocol can pay apps more than an ISP contributed by drawing on reserved
  common-fund liquidity, but the resulting ISP debt must be repaid; this gives
  the ISP time to adjust without making other participants permanently
  responsible for its consumption costs.

- **The ISP’s debt is updated mechanically:**

  \[
  D_{t+1}=\max(0,D_t+X_t-C_t-M_t-K_t)
  \]

  where \(X_t\) is executed consumption, \(C_t\) is commitments, \(M_t\) is debt
  service, and \(K_t\) is exceptional correction funding.

- **New communal surplus is recognized only after the ISP's opening debt has
  been repaid:**

  \[
  S_t=\max(0,C_t+M_t+K_t-X_t-D_t)
  \]

  so an ISP's positive net contribution first reduces its own liability and
  only the excess becomes unencumbered money of the common fund.

- **Every capital-account update is publicly reproducible:** the protocol
  publishes the ISP's opening debt, commitments, debt service, correction
  funding, executed consumption, and closing debt, leaving no discretionary
  write-off or private interpretation inside the monthly update.

- **Underspending first repays the ISP’s outstanding debt:** once debt reaches
  zero, any further net contribution becomes communal surplus.

- **An ISP never accumulates an ISP-owned reserve or positive claim on the
  fund:** money remaining after its debt is repaid belongs to the common fund.

- **Unused pot capacity is not new surplus contributed by the ISP:** an unused
  overdraft was never drawn and simply becomes available to the common fund
  again.

- **Persistent heavy consumption must return to the ISP’s own economics:**
  growing or ageing debt reduces future overdraft capacity and eventually
  requires larger commitments and explicit debt-service payments.

- **Persistent underfunding eventually creates a binding commitment floor:**
  the protocol tolerates temporary and seasonal gaps while recording ISP debt,
  but after roughly a year of structurally inadequate commitments it raises the
  minimum accepted in future HCDs; an ISP that then refuses to fund the new
  minimum cannot open another ESP epoch.

- **Raising commitments only to the level of current consumption stops debt
  growth but does not repay old debt:** actual amortization requires the ISP’s
  total payments to exceed current consumption.

- **Debt-service payments create no new allowance or pot capacity:** otherwise
  every repayment would recreate the liability it was intended to retire.

- **Past usage may justify a larger temporary credit limit, but it does not give
  the ISP free money:** any part actually used beyond its contributions must be
  repaid.

- **ISP debt does not replenish common-fund liquidity:** when the fund pays on
  an ISP’s behalf, cash leaves the fund and becomes reusable only after the ISP
  repays it.

- **The total pots assigned across all ISPs cannot exceed the common fund’s
  liquid backing:** every authorized allowance remains fully funded before
  execution.

- **New ISPs receive no unsecured overdraft by default:** their initial pot
  equals their commitments unless additional exposure is protected by adequate
  collateral.

- **The mechanism provides temporal smoothing rather than permanent subsidy:**
  temporary heavy months can be financed through the overdraft, but normal heavy
  consumption is ultimately paid through the responsible ISP’s commitments.

- **The common fund can lose money only through actual ISP default, not through
  ordinary use of a large pot:** collateral, debt limits, repayment rules and
  successor liability must contain that remaining risk.

## 3. Household allowance and fair-use control

- **Every household has one fungible monthly allowance:** it begins with a
  guaranteed base funded by the ISP's commitment and may grow through top-ups,
  while remaining one amount that can be spent across participating apps.

- **The ISP's subscriber contract defines the retail promise:** the plan sets
  the base, top-up entitlements, rate limits, and contractual maximum, while the
  protocol neither reads those terms nor attempts to design consumer tariffs.

- **The base allowance is guaranteed while top-ups are conditional:** a refusal
  during a hot month is legitimate when it follows the subscribed FUP and
  available capacity, while the signed refusal gives the household evidence if
  the ISP instead breaks the retail promise it sold.

- **The household’s financial exposure remains bounded by its retail contract:**
  ESP consumption, allowance top-ups, and ISP debt cannot automatically increase
  the household’s ISP bill; only the agreed plan price and any separately priced
  add-on explicitly accepted by the household may be charged.

- **Fair-use policy is implemented as an allowance faucet:** the household may
  request a top-up at any time, but the request carries no amount and the ISP
  alone decides how much of the remaining buffer to grant.

- **The faucet lets the ISP pace the release of its pot without queues or
  network throttling:** each top-up grant is drawn from the pot’s remaining
  top-up buffer and sized according to the capacity left, time remaining in the
  epoch, current demand, and per-household rate caps; a tail reserve prevents
  the buffer from being fully allocated before the month ends.

- **A prudent ISP manages its pot as two planning layers:** commitments cover
  the guaranteed base allowances, while capacity above them can be reserved and
  gradually released through the FUP faucet; the protocol enforces only the
  pot’s overall ceiling, leaving the ISP responsible for how it manages that
  capacity and the resulting household experience.

- **The pot is the ISP's non-negotiable solvency boundary:** the sum of all
  household allowances may never exceed it, so the ISP can exercise retail
  discretion without creating promises the protocol cannot fund.

- **Every allowance decision becomes a jointly signed historical fact:** an
  epoch opening, grant, or refusal produces a Household Signed Allowance Message
  (HSATM) carrying the epoch, sequence number, timestamp, and new total, signed
  by both the ISP and the household's box.

- **The latest signed message defines the live allowance, while the HLAA
  operationalizes it:** the highest-sequence HSATM carries the authoritative
  Household Signed Allowance Total (HSAT), and the box’s household-local
  allowance account combines that total with signed consumption to track the
  remaining balance and refuse requests that would exceed it.

- **The normal box enforces the allowance locally:** it declines to sign
  consumption beyond the authorized total, allowing the FUP to dose ordinary
  households in real time without a protocol query for each service request.

- **Economic feedback from app prices works through household user experience:**
  higher tariffs consume allowance faster at unchanged usage; when FUP limits
  further grants, expected app use can be interrupted. Analytics shows the costly
  app’s contribution, so households may reduce or stop using it to protect their
  overall experience, putting the app at risk of losing usage when it raises
  prices.

- **Household analytics make the cost of app choices visible:** the box shows
  allowance consumption by app and distinguishes tariff increases from increased
  usage, including what equivalent activity would have cost at earlier prices;
  this helps households identify which services consume their available
  capacity and make informed choices about continued use.

- **Top-up requests require no real-time proof of past spending:** instead, the
  request, answering allowance message, and app-attested Consumption Records
  (ConRecs) are signed and timestamped so their true order can be reconstructed
  later.

- **The ex-post audit separates three timing states:** consumption within the
  current allowance is compliant, consumption after a request but before a
  sufficient immediate grant is an allowed pending-grant race, and consumption
  before requesting or after an insufficient refusal is spend-ahead.

- **Hoarding and spend-ahead are contractual violations even if later events
  make the final arithmetic fit:** requesting far before the earlier allowance
  was exhausted or consuming before authorization remains visible in the
  reconstructed curves and is not erased by later catch-up or a later grant.

- **Pilot household timing audits stay private:** the box supplies its retained
  ConRecs to the pilot operator, the evidence must reconcile to the ISP's
  charged total, and consequences run through the ISP-household contract rather
  than a public slashing proceeding against the household.

- **Post-pilot FUP audits are bilateral:** when a household’s signed top-up
  pattern gives the ISP grounds to suspect hoarding or spend-ahead, the ISP may
  require the box to provide its ConRecs for the specified epoch; the ISP
  reconciles them with the IsHEC, reconstructs the allowance and consumption
  timelines, and issues a signed audit finding.

- **The audit creates limited but real privacy exposure:** no ConRecs become
  public, and the ISP already knows the household’s aggregate per-app
  consumption, but the audit additionally reveals its request-level amounts and
  timing; disclosure must therefore be limited to the audited epoch, used only
  for the FUP investigation, and deleted after the contractual challenge period;
  a production implementation may reduce this exposure by letting the box prove
  FUP compliance in zero knowledge, with private ConRec disclosure to the ISP
  used only when the proof cannot be produced or verified.

- **The ISP’s audit finding remains mechanically contestable:** because the ISP
  is both accuser and evaluator, its finding must be mechanical and signed; the
  household retains the same HSATMs and ConRecs and can challenge a dishonest
  finding through its contract and ordinary legal process, keeping household
  disputes bilateral and contractual rather than turning them into protocol
  adjudications.

- **A private timing audit must account for the household's complete charged
  consumption:** the submitted ConRecs are reconciled against the IsHEC, any
  gap is filled privately from the household or the apps identified by the ISP,
  and an incomplete submission or refusal to cooperate is itself a contractual
  breach.

## 4. Service requests and consumption evidence

- **Each app publishes one signed price catalogue for the epoch:** the
  catalogue identifies billable services, units, and rates; the household's box
  signs acceptance once, at first use, and all consumption from that app during
  the epoch uses those agreed prices.

- **Accepted prices remain fixed for the epoch:** ordinary service requests
  use the accepted catalogue, and app price increases take effect through a new
  catalogue and household acceptance in the next epoch; past consumption is
  never repriced.

- **Each charge remains traceable to the accepted catalogue:** the tariff
  agreement and consumption evidence must establish which service, quantity,
  and rate produced the claimed amount; accepting a catalogue neither spends
  allowance nor proves that the household consumed any service.

- **Every billable act produces a Consumption Record (ConRec) signed by both
  economic parties:** the household signs with its epoch key, the app
  countersigns and attests the time, and the resulting ConRec proves the app,
  amount, household pseudonym, and time of consumption.

- **Price agreements and fine-grained evidence remain off-chain during
  ordinary operation:** apps retain accepted tariff agreements and ConRecs
  needed to prove their claims, households retain the agreements and an
  independent local diary, and normal settlement does not publish the
  household's request-by-request history.

- **Serving can remain optimistic:** apps may provide services before final
  settlement or while a top-up is pending, but if valid consumption ultimately
  exceeds the household’s closing allowance, the HEEA is divided pro rata among
  the valid claims and the serving apps collectively absorb the shortfall; the
  common fund never pays beyond the household’s funded allowance.

- **Evidence retention outlives payment finality:** an app's monthly payment may
  become final after the challenge window, but the underlying ConRecs must
  remain retrievable long enough for escalation audits and contractual recovery
  across earlier epochs; for the pilot, the retention period is the full life of
  the pilot.

## 5. Epoch identity and privacy

- **A household receives a fresh cryptographic identity for every epoch:** the
  box generates a new keypair, the public key becomes the household epoch ID
  (HEID), and the private key signs that month's consumption without creating a
  stable cross-month identifier.

- **The epoch-opening allowance message binds identity to entitlement:** the
  ISP's signature on the opening HSATM certifies that the newly minted HEID
  belongs to a participating subscriber with a real allowance, so apps can
  verify later household signatures directly against that HEID.

- **The ISP and box also share one private verification secret:** it is created
  when allowance bookkeeping is established and derives a new one-way tag each
  epoch, allowing only those two parties to recognize the household's public
  closing-allowance entry.

- **The identity model has three deliberate layers:** the real household is
  known to its ISP, the plaintext epoch ID is known to the household, ISP, and
  apps it used, and freshly randomized encryptions of that ID are the only form
  placed in ordinary public records.

- **Only the parent ISP can resolve a public claim to a household:** each public
  claim row contains the household’s HEID encrypted with the parent ISP’s public
  key; the ISP uses its private key to recover the plaintext HEID and then
  consults its subscriber records to identify the real household, while apps and
  outside observers cannot construct the complete cross-app mapping.

- **Fresh encryption randomness prevents public basket reconstruction:** two
  apps claiming against the same household produce unlinkable ciphertexts, and
  even an app that knows its own customer's epoch ID cannot recognize that
  customer in another app's claim.

- **The public Allowance to Spend (AtS) is anonymous but self-verifiable:**
  every entry contains an encrypted HEID, the household’s closing allowance,
  and a rotating verification tag that only the ISP and the corresponding box
  can compute.

- **The AtS verification tag gives a household visibility without giving apps a
  lookup table:** the box computes its epoch-specific tag, uses it to find and
  verify its own closing allowance in the public AtS, while apps cannot compute
  the tag and therefore cannot combine a customer’s allowance with their own
  billing to estimate unused slack for fraudulent padding.

- **The household independently checks both sides of its monthly equation:** it
  compares the public closing allowance against its signed allowance messages
  and compares the ISP-side Household Epoch Consumption (IsHEC), a private
  signed total, against its own diary.

- **The IsHEC must reach the household while payment can still be stopped:** the
  ISP delivers it early in the challenge window, the box alerts on a mismatch or
  missed delivery deadline, and the pilot agreement compels the ISP to produce
  the signed message on demand; after execution, the household retains only the
  legal recovery path.

- **Ordinary request-level Consumption Records remain with the household and
  serving apps:** the box retains its complete ConRec diary and each app
  retains the ConRecs it served, while the parent ISP normally sees only
  per-app household aggregates needed for reconciliation; detailed ConRecs
  reach the ISP only during a private FUP audit and become public only during an
  evidence round for the disputed household and epoch.

## 6. Monthly claims and ISP reconciliation

- **The ISP opens every epoch by declaring and funding its participating
  households:** the Household Commitment Declaration (HCD) contains one
  encrypted HEID and public commitment per household, and the closing AtS must
  contain the same number of household entries; this publicly checks participant
  count, while each household separately verifies its own AtS entry.

- **Each app converts many service requests into one monthly claim:** its Request
  to get Paid (RtgP) contains one row per household per ISP, where each row
  carries a freshly encrypted epoch ID and the aggregate amount owed by that
  household to that app.

- **Every app’s Request to get Paid (RtgP) carries publicly checkable ISP
  subtotals:** for each ISP, the protocol verifies that the RtgP header subtotal
  equals the sum of all row amounts addressed to that ISP before accepting the
  claim, preventing an app and ISP from inflating the aggregate payout through a
  false header total.

- **Each ISP posts one closing allowance list for the epoch:** the Allowance to
  Spend (AtS) records every household's final signed allowance and partitions
  the ISP's pot into household epoch escrow accounts used for settlement.

- **The AtS is a closing report rather than a live spending oracle:** during the
  epoch the highest-sequence HSATM is the authoritative allowance, while the AtS
  becomes the public settlement and arbitration baseline after the epoch closes.

- **A household escrow account is an accounting container, not a separate money
  transfer:** the household epoch escrow account (HEEA) caps what may be paid
  for one household in one epoch while the underlying money remains inside the
  protocol-held ISP pot.

- **The ISP reconciles all apps together rather than processing claims in
  arrival order:** it decrypts and groups every row by household, compares each
  household's combined claims against its escrow cap, and cannot favor an early
  app by spending the allowance before later claims arrive.

- **The IPtD publishes settlement outcomes without exposing household app
  baskets:** after privately grouping all RtgP rows by household, the ISP
  publishes each app’s proposed payout, its flagged rows, the aggregate amount
  charged, and the remainder; it never publishes which rows from different apps
  belong to the same household.

- **Public verification checks arithmetic without repeating the ISP's private
  reconciliation:** payouts plus remainder must equal the corrected closing
  allowance total, that total must fit inside the pot, and no app may receive
  more than the subtotal in its own accepted claim.

- **Clean households settle and flagged households freeze:** claims within a
  household's escrow proceed to payment, while an aggregate above the cap stops
  every row for that household and automatically opens an evidence round before
  any of those rows are paid.

- **Payments are aggregated while supporting evidence remains available:** the
  protocol combines payable claims into one epoch payment per app; the RtgP rows
  remain in the public record, while serving apps and household boxes retain the
  underlying signed ConRecs and produce them only when an audit or evidence
  round requires them.

- **Unused pot capacity never becomes ISP revenue:** whether it was never
  assigned to a household allowance or remains unspent in a HEEA after
  settlement, it is released for reuse within the common fund after execution
  and the ISP capital-account update.

- **The pilot uses a hard deadline for app claims:** an RtgP submitted after the
  deadline is excluded from that epoch and receives no payment, giving the ISP a
  final, closed set of claims to reconcile.

- **Failure to open or close an ISP epoch has explicit consequences:** an ISP
  that does not fund its commitments has no participating epoch, while a missed
  AtS, unpaid required debt service, or unfunded allowance correction sends the
  ISP into collateral slashing and forced wind-down.

- **A missing pilot IPtD invokes emergency settlement:** the ISP is slashed for
  missing its deadline, and affected apps reveal their HEIDs to the pilot
  operator, which acts as the second instance and attempts to reconstruct the
  required claim assignments; the equivalent post-pilot recovery mechanism
  remains undefined.

- **Pilot settlement becomes final when execution runs:** the books and sweep
  are then immutable, so fraud proved later can still cause slashing, expulsion,
  and legal recovery but does not reverse the executed protocol payments.

## 7. Evidence rounds, fraud allocation, and remedies

- **An evidence round can arise from three provable triggers:** an overrun flag
  opens one automatically, a household diary mismatch reaches the pilot operator
  through the signed consumption report, and an app may challenge an ISP
  disbursement that mishandled its own rows.

- **A Call for Evidence turns the dispute into a bounded public proceeding:**
  the Call for Evidence from Apps (CfEfA) requires every summoned app to
  publish the signed ConRecs supporting its rows for that household and epoch
  or face slashing.

- **Evidence responses deliberately reveal one disputed household's epoch
  basket:** ConRecs are posted in plaintext so anyone can verify their
  signatures and arithmetic, and the household is warned that an app it used
  can connect the basket to its identity and that repeated exposed baskets may
  remain recognizable across epochs despite rotating pseudonyms.

- **Resolution is designed to be mechanical rather than discretionary:** a
  ConRec either has valid signatures or it does not, evidenced amounts either
  fit the corrected allowance or they do not, and the resulting arithmetic
  determines which claims survive.

- **The ISP supplies the definitive witness list but does not judge disputes in
  which it is implicated:** it maps the disputed household to all claimant apps
  and posts the CfEfA, while an omitted-app allegation or contested IPtD goes to
  the second instance and may require the challenging app to reveal its HEID.

- **False inclusion in an evidence call is self-correcting:** an app that holds
  no row answers with a signed denial, forcing the ISP to produce the attributed
  ciphertext and prove its decryption; an ISP that cannot do so has exposed its
  own false listing.

- **Every challenge begins from evidence already controlled by the challenger:**
  apps rely on their posted rows and the public IPtD, while household findings
  rely on signed HSATMs or the signed IsHEC and reach the protocol through the
  pilot operator rather than a household transaction.

- **An unsupported row is app fraud:** the row is voided, the app is slashed,
  and one proven fabrication escalates into an audit of that app's entire epoch
  rather than being treated as an isolated mistake.

- **An escalation audit follows the app across every retained claim it can
  still be required to prove:** unexecuted fraudulent rows are voided, while
  convictions concerning already executed pilot epochs support slashing,
  expulsion, and external recovery rather than reversal of final payments.

- **Valid consumption beyond the closing allowance is household fraud:** in the
  pilot, the household escrow is divided pro rata across the valid app claims,
  each app receives its share, and the serving apps absorb the remaining
  shortfall as the consequence of their optimistic credit decisions.

- **A false closing allowance cannot be used to convict an honest household:**
  the box detects a shaved entry through its verification tag, a higher-sequence
  signed allowance message corrects the adjudication baseline, and any amount
  beyond the reserved pot must be funded by the ISP before execution.

- **An allowance correction first uses pot capacity already reserved for the
  ISP:** only the part that would push the corrected AtS total above the pot
  requires new ISP funding, which increases the pot by exactly that amount and
  enters the capital account as \(K_t\); it can never be added retroactively to
  the ISP's overdraft.

- **Household and app compliance use different time horizons:** a later grant
  may make an app's optimistic service financially payable under the final
  allowance, but it never rewrites whether the household consumed before it had
  requested and received sufficient authorization.

- **Freezing an overrun normally prevents fraudulent money from leaving the
  fund:** if valid claims of 450 and a fabricated claim of 250 meet an allowance
  of 500, all 700 freezes, the unsupported 250 is voided, and the honest 450 is
  paid in full without any clawback.

- **A dishonest household cannot make the common fund exceed its funded
  exposure:** app payouts remain capped by the corrected HEEA, so the household
  can obtain only the bounded amount of optimistic service that apps elected to
  extend beyond that cap.

- **The pilot separates protocol penalties from household remedies:** apps and
  ISPs can be slashed or expelled through protocol and pilot machinery, while
  household breaches and household claims against the ISP run through subscriber
  contracts, the pilot operator, and ordinary law.

- **The fraud posture is detection plus consequences rather than universal
  real-time prevention:** signed evidence makes later reconstruction possible,
  caps bound interim exposure, and collateral, escalation, expulsion, and legal
  recovery make fabrication an unattractive repeated strategy.

- **Ordinary silent padding is exposed through overlapping signals:** broad
  padding eventually pushes some household over its cap, an inflated charged
  total conflicts with that household's diary, and one proven false row expands
  the inquiry from a single household to the app's complete retained activity.

## 8. Roles, sequencing, and scaling boundaries

- **The household box is an observer in the pilot:** it signs and retains
  evidence, tracks allowance locally, checks its public allowance entry and
  private charged total, and alerts the household, but never has to post a
  routine protocol transaction.

- **The ISP is trusted with private mapping and computation but not with payment
  discretion:** it knows which rows belong to which household and constructs the
  disbursement plan, while public rules determine the available pot, arithmetic
  constraints, freezes, and final transfers.

- **Apps are both service providers and evidence custodians:** they choose their
  prices and optimistic credit limits, submit one monthly claim, verify their own
  treatment in the disbursement plan, and must produce signed ConRecs when
  challenged.

- **Every app must post enough registration collateral to make disposable
  padding identities uneconomic:** the collateral backs evidence duties,
  escalation audits, and slashing even when the app intended to disappear after
  one fraudulent epoch.

- **The pilot operator bridges household findings into protocol action:** it
  receives household evidence, convenes appropriate rounds, relays a proven
  allowance correction, and acts as second instance when the ISP itself is a
  party.

- **Commitment declarations are privately auditable without publishing
  subscriber identities:** the pilot operator may sample entries and require
  the ISP to show that each corresponds to a real subscriber contract on a live
  access line, with suspicious wash-consumption shapes steering the sampling.

- **The epoch timetable prevents races and premature sweeps:** commitments,
  debt service, and pots precede serving; claims and closing allowances close in
  parallel; reconciliation precedes the challenge window; execution precedes
  the debt update; and only then are remainders released.

- **Blockchain load scales with participants and disputes rather than usage
  volume:** ordinary service requests remain off-chain, while each app and ISP
  makes a fixed number of epoch posts plus the exceptional transactions needed
  for actual evidence rounds.

- **The fixed epoch footprint is explicit:** each app posts one RtgP; each ISP
  has one HCD, commitment payment, allocation, AtS, IPtD, and capital-account
  update, with at most one debt-service and one correction-funding payment;
  only an actual dispute adds a CfEfA and its evidence responses.

- **The protocol preserves gross evidence wherever it nets money:** aggregate
  settlement reduces transfer count without destroying the ability to audit the
  requests, household caps, and claim rows that produced each payment.

- **The protocol deliberately leaves retail product design outside consensus:**
  household prices, service categories, FUP generosity, and contractual remedies
  belong to ISPs and their customers, while the protocol enforces backing,
  signatures, deadlines, aggregate arithmetic, debt, and dispute consequences.

## 9. Attack vectors

- **Allowance hoarding front-runs the ISP’s top-up buffer:** a household requests
  additional allowance while its existing allowance remains largely unspent,
  accumulating scarce capacity before it needs it and potentially leaving less
  for households with later genuine demand; the private timing audit exposes
  the early requests even if the household eventually spends the allowance.

- **Spend-ahead consumes future allowance before the ISP grants it:** a tampered
  box signs consumption beyond the current HSAT before requesting a top-up, or
  after a refusal or insufficient grant, hoping that a later grant will make the
  closing total fit; the later grant may fund the apps but timestamped evidence
  preserves the household’s temporal breach.

- **Silent padding hides a fabricated app charge below the household’s HEEA:**
  a dishonest app inflates its RtgP without supporting ConRecs but keeps the
  household’s aggregate claims below its closing allowance, so no automatic
  overrun fires; when the ISP reports the inflated total in the IsHEC, the box’s
  lower diary total exposes the mismatch and triggers an evidence round before
  payment.

- **Allowance lookup would enable targeted silent padding:** if an app could
  identify its customer’s entry in the AtS, it could compare the closing
  allowance with its own billing and inflate its claim within the estimated
  unused slack, reducing the chance of triggering an overrun and evidence round;
  encrypted HEIDs and private verification tags deny the app that lookup, making
  unsupported padding blind and more likely to expose itself through an overrun.

## 10. Open production work — not yet ratified machinery

- **Epoch tariff agreements still need a format and evidence specification:**
  catalogue identifiers, signatures, acceptance binding, and evidence-round
  disclosure must be specified consistently in the authoritative design and
  message catalogue.

- **The ISP credit policy still needs numerical calibration:** debt ceilings,
  debt ageing, collateral ratios, amortization schedules, commitment-adequacy
  tests, correlated-liquidity stress, and the default waterfall require pilot
  distributions and an explicit adversarial pass.

- **Dishonest-ISP analysis remains incomplete:** the design must test allowance
  shaving, dishonest refusals motivated by debt, tag-to-ciphertext substitution,
  missed debt service, correction-funding failure, and every place where the ISP
  controls a private mapping.

- **ISP-and-app collusion still has an undefeated silent-padding form:** a
  dishonest ISP can help an accomplice app fabricate plausible household rows
  and falsify the private consumption report while suppressing the evidence
  summons that would expose the app.

- **Several production anti-collusion mechanisms remain candidates:** a public
  charged-total annex using household verification tags, broadcast evidence
  summons, compelled verifiable decryption, and random evidence sampling are
  designed to work together but are not part of the ratified pilot mechanism.

- **Borrow-and-default replaces consumption-weighted allocation farming as the
  central common-fund attack:** a wash app can turn an ISP overdraft into cash,
  but the extraction becomes profitable only if the ISP can evade the resulting
  debt through default, restructuring, affiliation, or weak collateral recovery.

- **Production needs a durable second instance:** disputes in which the ISP is a
  party cannot be judged by that ISP, and the pilot operator is a temporary
  institutional answer rather than the final protocol design.

- **Production needs a deliberate finality and clawback horizon:** the pilot
  makes executed payments final and relies on contract law for late recovery,
  while a mature system needs offsets against future payouts, collateral draws,
  and restitution routing for fraud discovered after execution.

- **ISP fronting of household shortfalls remains optional future work:** paying
  apps in full and recovering from the household could improve app certainty,
  but making the ISP an obligatory insurer would expose it to hacked boxes and
  household-app collusion.
----- END SOURCE /home/ibmko/lab/oe/materials/Whitepaper/v0.2/notes-allowance-architecture-summary.md -----
