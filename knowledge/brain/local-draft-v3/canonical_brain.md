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

- **Each ISP prepays one aggregate monthly commitment `C` and attributes it
  across its household roster:** the entry amounts sum to `C`, but
  they are ISP-declared funding attributions, not household allowances, and need
  not equal HSATM amounts. Roster membership makes a household eligible for
  later activation; it does not itself activate ESP participation. Only
  aggregate `C` enters protocol capital accounting. The per-household fields are
  retained as a possible basis for future household transparency, whose
  mechanism remains undefined.

- **The protocol assigns each ISP a monthly pot:** the pot is a protocol-held
  spending envelope and the hard ceiling on the total allowances the ISP may
  authorize.

- **The pot may be larger than the ISP’s commitments:** the difference is the
  ISP overdraft allocation `L`, common-fund capacity reserved for that ISP.
  Allocation alone is neither a transfer nor a debt draw.

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

- **Unresolved debt-control rules may eventually raise an ISP's aggregate HCD
  requirement:** the protocol defines no minimum commitment per household and
  initially accepts the ISP's declared HCD commitments. It records ISP debt and
  does not permit that debt to accumulate indefinitely. If the ISP fails to
  reduce it over the required number of epochs, the eventual debt-control rules
  must be able to require a higher aggregate `C` in a future HCD or prevent the
  ISP from opening another epoch. The exact formula, thresholds and number of
  epochs remain TODO.

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

- **Every activated household has one fungible monthly allowance:** it ordinarily
  begins with a base defined by the ISP-household retail relationship and may
  grow through top-ups, while remaining one amount that can be spent across
  participating apps. A rostered household without a valid opening HSATM has the
  zero default instead. The protocol does not derive the base from the
  household's HCD attribution or require the two amounts to match.

- **The ISP's subscriber contract defines the retail promise:** the plan sets
  the base, top-up entitlements, rate limits, and contractual maximum, while the
  protocol neither reads those terms nor attempts to design consumer tariffs.

- **The base allowance is guaranteed while top-ups are conditional:** a refusal
  during a hot month is legitimate when it follows the subscribed FUP and the
  ISP's management of its pot, while the signed refusal gives the household
  evidence if the ISP instead breaks the retail promise it sold.

- **The household’s financial exposure remains bounded by its retail contract:**
  ESP consumption, allowance top-ups, and ISP debt cannot automatically increase
  the household’s ISP bill; only the agreed plan price and any separately priced
  add-on explicitly accepted by the household may be charged.

- **Fair-use policy is implemented as an allowance faucet:** the household may
  request a top-up at any time, but the request carries no amount and the ISP
  alone decides how much to grant, subject to the household's retail contract
  and the ISP's aggregate pot ceiling `P`.

- **Grant sizing and pacing are internal to the ISP:** the protocol defines no
  remaining-grant-capacity field, grant-sizing formula or tail-reserve rule. The
  ISP is responsible for managing all allowance grants within `P` and for
  honoring its household contracts.

- **A prudent ISP manages one aggregate pot across opening allowances and later
  top-ups:** `C` is the prepaid funding layer and `P - C` is the underwritten
  credit layer, but neither layer is assigned by the protocol to particular
  household allowances. The protocol enforces only the pot's overall ceiling,
  leaving the ISP responsible for its internal allocation and the resulting
  household experience.

- **The pot is the ISP's non-negotiable solvency boundary:** the sum of all
  household allowances may never exceed it, so the ISP can exercise retail
  discretion without creating promises the protocol cannot fund.

- **Every allowance decision becomes a jointly signed historical fact:** an
  epoch opening, grant, or refusal produces a Household Signed Allowance Message
  (HSATM) carrying the epoch, sequence number, timestamp, and new total, signed
  by both the ISP and the household's box. The opening HSATM also fixes the
  household's exact AtS verification-tag and ciphertext pair through an
  immutable binding digest, and every later HSATM repeats that same digest.

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
  (ConRecs) are signed and timestamped, allowing a later FUP audit to
  reconstruct the parties' asserted ordering between HSATM allowance decisions
  and consumption. Those timestamps do not independently prove the actual
  signing order or establish when an app obtained or checked an HPC; the HPC has
  no issuance time and the ConRec does not bind to it.

- **The ex-post audit separates two timing states:** consumption is compliant
  while cumulative signed consumption stays within the allowance established by
  the latest HSATM already in force; any excess is spend-ahead. A top-up request
  creates no authorization, and a later grant does not change that historical
  classification.

- **Hoarding and spend-ahead are contractual violations even if later events
  make the final arithmetic fit:** requesting far before the earlier allowance
  was exhausted or consuming before authorization remains visible in the
  reconstructed curves and is not erased by later catch-up or a later grant.

- **End-state FUP audits are arbitrated by the ESP protocol:** neither the ISP
  nor a privileged operator decides whether the signed timeline establishes
  hoarding or spend-ahead. The invocation route, standing, deadlines, result
  record and connection to ISP-household contractual remedies remain deferred.

- **The likely audit mechanism is based on zero-knowledge proofs:** it should
  let the relevant FUP timing conditions be checked without routinely
  disclosing the household's complete ConRec diary. The proof relation,
  committed policy inputs, proof-generation and protocol-verification interface,
  completeness guarantee and any fallback disclosure are not yet designed.

- **The protocol audit result does not define the household's retail remedy:**
  the protocol is the arbiter of the evidentiary finding, while consequences for
  household misconduct continue through the ISP-household contract. The design
  does not introduce household collateral or public slashing.

- **The privacy-preserving protocol-arbitrated FUP audit must account for the
  household's complete charged consumption:** the audit must not permit selective
  omission of ConRecs. How the zero-knowledge mechanism anchors completeness,
  how it uses or checks the ISP-authored IsHEC, what fallback evidence is
  admissible, and how a failure to prove is treated remain part of the deferred
  audit design.

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

- **Serving can remain optimistic:** an app may accept the risk of serving
  against a household-signed ConRec that exceeds the allowance then in force. A
  pending top-up request creates no authorization, although a later grant may
  make the app's valid claim payable against the closing allowance. If valid
  consumption exceeds that closing allowance, the HEEA is divided pro rata among
  the valid claims and the serving apps collectively absorb the shortfall; the
  common fund never pays beyond the household's funded allowance.

- **Evidence retention outlives execution:** the underlying ConRecs must remain
  retrievable after an app is paid so escalation audits and whatever
  post-execution remedy is eventually adopted can reach earlier epochs. The
  exact retention period is deferred with settlement finality and recovery.

## 5. Epoch identity and privacy

- **The box creates the epoch identity before the ISP declares the household:**
  for every epoch, the box generates a new keypair, the public key becomes the
  household epoch ID (HEID), and the box proves control of the corresponding
  private key to the ISP. This identity-generation step does not create an
  allowance; the exact bilateral transport for the control proof remains
  unspecified and adds no new protocol message or field.

- **Epoch opening follows one required dependency order:** (1) the box generates
  the fresh HEID and proves control to the ISP; (2) the protocol accepts the HCD
  containing that HEID together with the ISP's required funding and any required
  debt-service payment; (3) the protocol assigns and activates the ISP's pot;
  (4) during household activation, the box creates its AtS-only ciphertext and
  the ISP verifies it; (5) the ISP and box make the binding-bearing sequence-zero
  opening HSATM effective for that same HEID; (6) the ISP issues the matching
  HPC; and only then (7) may the first ESP-billable service begin. Steps (4)
  through (6) may complete later in the same epoch, but they must retain this
  order and finish before that household's first ESP-billable interaction.

- **A rostered household defaults to zero allowance until it is activated:** an
  accepted HCD entry reserves the household's place in the epoch but creates no
  allowance. If no valid sequence-zero opening HSATM has become effective, the
  household's effective allowance is zero, the ISP must not issue an HPC for it,
  and service under that HEID cannot be treated as ESP-billable.

- **The epoch-opening allowance message binds private allowance state to an
  already generated epoch identity:** the ISP and household jointly sign the
  sequence-zero opening HSATM for the same HEID carried through the opening
  sequence, establishing that household's initial allowance between those
  parties. The HSATM does not generate or mint the HEID. Apps do not inspect the
  private HSATM and cannot use it as proof of ESP participation.

- **The Household Participation Credential (HPC) is the required app-facing
  admission proof:** after a rostered household's opening HSATM becomes
  effective, the ISP issues the box a signed credential binding the ISP, epoch,
  and HEID. Before treating service as ESP-billable, an app verifies the ISP
  signature, matches the epoch and HEID, and verifies that the household controls
  the corresponding private key. The credential discloses neither the
  household's allowance nor its HCD contribution attribution.

- **The current evidence does not prove that admission preceded a ConRec:** the
  rule above still prohibits every ESP-billable interaction before the app has
  verified a valid HPC for that epoch. However, the HPC has no activation
  timestamp or `valid_from` value, and a ConRec does not reference the HPC. If a
  buggy or dishonest app ignores the rule, signs a ConRec before activation, and
  the same HEID later receives a valid HPC, the retained artifacts cannot
  establish that ordering. If service did precede HPC verification, later
  activation does not retroactively satisfy the mandatory check or cure that
  earlier noncompliance. This is distinct from optimistic serving or spend-ahead
  by an already admitted household, where a valid HPC exists but the service may
  exceed the allowance then in force.

- **The ISP and box also share one private verification secret:** it is created
  when allowance bookkeeping is established and derives a new one-way tag each
  epoch, allowing only those two parties to recognize the household's public
  closing-allowance entry.

- **The box prepares the ciphertext used in its AtS entry during household
  activation:** after the HCD and required funding have been accepted and the
  ISP's pot assigned, but immediately before the opening HSATM is co-signed, the
  box encrypts its HEID to the ISP under the designated ISP encryption key with
  fresh randomness, supplies that AtS-only ciphertext to the ISP, and retains
  both the ciphertext and randomness. The ISP decrypts it and verifies that it
  contains the same HEID whose private-key control the box proved before the
  HCD. This activation step is distinct from that pre-HCD HEID generation and
  control proof, and the ciphertext is distinct from freshly randomized
  encryptions used for other public records.

- **The opening HSATM preserves evidence of the exact AtS identity pair:** for
  verification tag `T`, AtS-only ciphertext `C`, and the designated ISP
  encryption-key identifier, the jointly signed opening HSATM contains the
  private field `ats_entry_binding`, defined as

  \[
  \operatorname{Hash}(\texttt{"ESP-ATS-BIND-v1"},\; isp\_id,\; epoch,\; T,\;
  encryption\_key\_id,\; C).
  \]

  Every later HSATM for that household and epoch repeats this binding unchanged.
  It is private HSATM content, not a new HCD or AtS field and not a separate
  public message.

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
  verify its own closing allowance in the public AtS, and checks that the tag is
  paired with the exact AtS-only ciphertext committed by its HSATM. Apps cannot
  compute the tag and therefore cannot combine a customer’s allowance with
  their own billing to estimate unused slack for fraudulent padding.

- **A tag-to-ciphertext substitution is detected and evidenced after the
  fact:** the box compares the public AtS entry's amount with its latest HSATM
  and compares the entry's exact `(tag, ciphertext)` pair with the immutable
  HSATM binding. For a mismatch it retains the jointly signed HSATM, the
  expected tag and ciphertext, the ciphertext randomness, and the ISP-signed
  conflicting AtS. Those artifacts let a later adjudicator reproduce the
  encryption, verify the signed digest, and establish that the ISP published a
  different pair. The protocol does not automatically compare every AtS entry
  with a public HCD binding set; this follows ESP's evidence-first,
  post-mortem-challenge model.

- **The household independently checks both sides of its monthly equation:** it
  compares the public closing allowance against its signed allowance messages
  and compares the ISP-side Household Epoch Consumption (IsHEC), a private
  signed total, against its own diary.

- **The IsHEC must reach the household while payment can still be stopped:** the
  ISP delivers it early in the challenge window, the box alerts on a mismatch or
  missed delivery deadline, and the ISP has a duty to produce the signed message.
  The production-demand and escalation routes remain unresolved. Remedies for a
  mismatch established only after execution belong to the deferred finality and
  post-execution-recovery design.

- **Ordinary request-level Consumption Records remain with the household and
  serving apps:** the box retains its complete ConRec diary and each app
  retains the ConRecs it served, while the parent ISP normally sees only
  per-app household aggregates needed for reconciliation. Detailed ConRecs
  become public only during an evidence round for the disputed household and
  epoch. The separate FUP audit is expected to use zero-knowledge proofs rather
  than routinely reveal the diary; any fallback disclosure remains deferred.

## 6. Monthly claims and ISP reconciliation

- **The HCD is the protocol-facing funding step inside epoch opening:** after
  the box has generated its HEID and proved control to the ISP, the Household
  Commitment Declaration (HCD) contains one encrypted HEID and ISP-declared
  contribution attribution per household; the attributions sum to aggregate
  `C`, and the closing AtS must contain the same number of household entries.
  HCD acceptance and the associated required funding and debt service precede
  pot activation, which in turn precedes the opening HSATM and HPC. The HCD
  amounts do not establish allowances or constrain HSATMs. Each issued HPC must
  correspond to exactly one HCD entry. For protocol purposes, the ISP-signed
  HCD is authoritative for roster membership and the protocol trusts the ISP's
  declaration that this HCD-to-HPC correspondence is correct. It does not
  independently prove that an entry represents a real household on a live
  access line, establish subscriber consent, or prove that correspondence to
  apps or the public. Entry-count reconciliation remains public, while future
  household visibility into its own HCD attribution remains undefined.

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
  Spend (AtS) retains one entry for every HCD household. It records the latest
  valid signed allowance, or zero if no sequence-zero opening HSATM ever became
  effective, and partitions the ISP's pot into household epoch escrow accounts
  used for settlement. For an activated household it uses the exact
  verification-tag and AtS-only-ciphertext pair fixed by the household's HSATM
  binding.

- **Incomplete household activation does not rewrite the funded epoch:** if a
  household never obtains an effective opening HSATM, its HCD contribution
  remains part of aggregate `C`, its roster entry is neither removed nor
  amended, and no refund arises; its zero AtS entry and all unused money and pot
  capacity follow the ordinary end-of-epoch accounting. If an opening HSATM is
  effective but the ISP fails to deliver the HPC, the AtS still reports the
  latest valid signed allowance and ESP-billable service waits for credential
  delivery. That delivery failure is an ISP duty breach, not an accounting
  exception. A never-activated household has no jointly signed AtS binding, but
  its row is necessarily zero and it has no legitimate ESP consumption;
  substitution only among such zero rows has no settlement effect. A
  substitution involving any activated row remains detectable and provable by
  that household. These rules require no new public message or AtS field.

- **The AtS is a closing report rather than a live spending oracle:** during the
  epoch the highest-sequence HSATM is the authoritative allowance, while the AtS
  becomes the public settlement and arbitration baseline after the epoch closes.

- **A household escrow account is an accounting container, not a separate money
  transfer:** the household epoch escrow account (HEEA) caps what may be paid
  for one household in one epoch while the underlying money remains inside the
  protocol-held ISP pot.

- **The ISP reconciles all accepted app claims together rather than processing
  them in arrival order:** it decrypts and groups every row by household,
  compares each household's combined claims against its escrow cap, and cannot
  favor an early app by spending the allowance before later claims arrive.

- **The IPtD publishes settlement outcomes without exposing household app
  baskets:** after privately grouping all accepted RtgP rows by household, the
  ISP publishes each app’s proposed payout, its flagged rows, the aggregate
  amount charged, and the remainder; it never publishes which rows from
  different apps belong to the same household.

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
  from accepted claims remain in the public record, while serving apps and
  household boxes retain the underlying signed ConRecs. Apps disclose the
  records required by a CfEfA evidence round. For a household FUP audit, the
  proof or evidence obligation—including whether raw ConRecs are ever disclosed
  as fallback—remains part of the deferred protocol-arbitrated mechanism.

- **Unused pot capacity never becomes ISP revenue:** whether it was never
  assigned to a household allowance or remains unspent in a HEEA after
  settlement, it is released for reuse within the common fund after execution
  and the ISP capital-account update.

- **App claims have a hard deadline:** an RtgP received after the deadline is
  rejected and excluded from that epoch; the app receives no protocol payment
  under it. It is not carried forward, and settlement is neither extended nor
  reopened for it. This gives the ISP a final, closed set of claims to reconcile.

- **Failure to open or close an ISP epoch has explicit consequences:** an ISP
  that does not fund its commitments has no participating epoch, while a missed
  AtS, unpaid required debt service, or unfunded allowance correction
  establishes an ISP default. Collateral slashing and forced wind-down remain
  intended consequences, but the machinery that imposes them is deferred.

- **A missing IPtD requires an emergency-settlement route:** missing the
  deadline establishes an ISP violation for which slashing and possible
  expulsion are intended consequences. How a second instance reconstructs the
  required claim assignments, executes emergency settlement, and imposes those
  consequences remains undefined.

- **Settlement finality after execution is deferred:** the design defines the
  initial payment execution and sweep but does not yet decide when payments
  become irreversible, whether later fraud evidence can change or recover them,
  or what recovery mechanism and horizon apply.

## 7. Evidence rounds, fraud allocation, and remedies

- **An evidence round can arise from three provable triggers:** an overrun flag
  opens one automatically, a household diary mismatch reaches the protocol
  through the unresolved household-report route using the signed consumption
  report, and an app may challenge an ISP disbursement that mishandled its own
  rows.

- **A Call for Evidence turns the dispute into a bounded public proceeding:**
  every app summoned by the Call for Evidence from Apps (CfEfA) must publish
  the signed ConRecs supporting its rows for that household and epoch by the
  deadline. Failure establishes an evidence-duty violation. Slashing and
  possible expulsion are intended consequences of that violation, under
  deferred penalty machinery.

- **Evidence responses deliberately reveal one disputed household's epoch
  basket:** ConRecs are posted in plaintext so anyone can verify their
  signatures and arithmetic, and the household is warned that an app it used
  can connect the basket to its identity and that repeated exposed baskets may
  remain recognizable across epochs despite rotating pseudonyms.

- **Resolution is designed to be mechanical rather than discretionary:** a
  ConRec either has valid signatures or it does not, evidenced amounts either
  fit the corrected allowance or they do not, and the resulting arithmetic
  determines which claims survive.

- **The ISP supplies the authoritative witness list:** it must map the disputed
  household to every claimant app and row and post them in the CfEfA. The
  protocol accepts the ISP's signed list as complete without independently
  verifying omissions; only listed apps acquire an evidence duty in that round.
  A future trustless completeness mechanism may replace this assumption.

- **False inclusion in an evidence call is self-correcting:** an app that holds
  no row answers with a signed denial, forcing the ISP to produce the attributed
  ciphertext and prove its decryption; an ISP that cannot do so has exposed its
  own false listing.

- **Every challenge begins from evidence already controlled by the challenger:**
  apps rely on their posted rows and the public IPtD, while household findings
  rely on signed HSATMs or the signed IsHEC. For an AtS tag-to-ciphertext
  mismatch, the household additionally retains the expected tag, box-created
  ciphertext and its encryption randomness, which can be checked against both
  the HSATM binding and the ISP-signed AtS. The eventual household-to-protocol
  challenge route remains unsealed.

- **An unsupported row is voided, but missing evidence alone does not prove
  fabrication:** failure to support a row by the deadline establishes a missed
  evidence duty. If the evidence instead proves that the app fabricated the
  row, that is app fraud and escalates into an audit of the app's entire epoch
  rather than being treated as an isolated mistake. Both a missed duty and
  proven misconduct enter the deferred penalty-enforcement path, whose intended
  consequences include slashing and possible expulsion.

- **An escalation audit follows the app across every retained claim it can
  still be required to prove:** the audit mechanism, proof duties, disclosure
  boundary and authoritative result remain deferred. The likely direction is an
  ESP-native audit protocol based on zero-knowledge proofs that tests the app's
  full-epoch claims without routinely publishing its complete retained activity;
  no proof construction or message is selected. Unexecuted fraudulent rows are
  voided. The monetary and non-monetary consequences of a conviction concerning
  an already executed epoch depend on the deferred finality and
  post-execution-recovery design.

- **Valid consumption beyond the closing allowance is household fraud:** the
  household escrow is divided among the valid app claims in proportion to their
  amounts, each app receives its resulting share, and the serving apps absorb
  the remaining shortfall as the consequence of their optimistic credit
  decisions. This pro-rata allocation is the standing protocol rule.

- **A false closing entry cannot be used to convict an honest household:** the
  box detects a shaved amount through its verification tag and latest HSATM, and
  detects a substituted tag-to-ciphertext pairing through the immutable HSATM
  binding. The signed evidence establishes the correct adjudication baseline;
  any amount beyond the reserved pot must be funded by the ISP before execution.

- **An allowance correction first uses pot capacity already reserved for the
  ISP:** only the part that would push the corrected AtS total above the pot
  requires new ISP funding, which increases the pot by exactly that amount and
  enters the capital account as \(K_t\); it can never be added retroactively to
  the ISP's overdraft.

- **Household and app compliance use different time horizons:** a later grant
  may make an app's optimistic service financially payable under the final
  allowance, but it never rewrites whether the household exceeded the allowance
  established by the latest HSATM already in force when it consumed.

- **Freezing an overrun normally prevents fraudulent money from leaving the
  fund:** if valid claims of 450 and a fabricated claim of 250 meet an allowance
  of 500, all 700 freezes, the unsupported 250 is voided, and the honest 450 is
  paid in full without any clawback.

- **A dishonest household cannot make the common fund exceed its funded
  exposure:** app payouts remain capped by the corrected HEEA, so the household
  can obtain only the bounded amount of optimistic service that apps elected to
  extend beyond that cap.

- **Protocol penalties and household remedies are distinct:** proven app and
  ISP violations are intended to lead to slashing or expulsion under the
  deferred penalty-enforcement design, while household breaches and household
  claims against the ISP remain matters for subscriber contracts and ordinary
  law.

- **The fraud posture is detection plus consequences rather than universal
  real-time prevention:** signed evidence makes later reconstruction possible,
  caps bound interim exposure, and escalation audits, intended collateral-backed
  penalties, possible expulsion, and legal recovery make fabrication an
  unattractive repeated strategy.

- **Ordinary silent padding is exposed through overlapping signals:** broad
  padding eventually pushes some household over its cap, an inflated charged
  total conflicts with that household's diary, and one proven false row expands
  the inquiry from a single household to the app's complete retained activity.

## 8. Roles, sequencing, and scaling boundaries

- **The household box is an observer in ordinary operation:** it signs and
  retains evidence, tracks allowance locally, checks its public allowance entry
  and private charged total, and alerts the household, but never has to post a
  routine protocol transaction. Exceptional evidence submission remains an
  unresolved route.

- **The ISP is trusted with private mapping and computation but not with payment
  discretion:** it knows which rows belong to which household and constructs the
  disbursement plan, while public rules determine the available pot, arithmetic
  constraints, freezes, and final transfers.

- **Apps are both service providers and evidence custodians:** they verify the
  household's HPC and proof of HEID-key control before treating service as
  ESP-billable, choose their prices and optimistic credit limits, submit one
  monthly claim, verify their own treatment in the disbursement plan, and must
  produce signed ConRecs when challenged.

- **App registration collateral remains part of the intended end state:** it is
  meant to back evidence duties and penalties even when an app intends to
  disappear after one fraudulent epoch. Its exact floor and sizing, custody,
  and disposition remain unsealed with the rest of penalty enforcement.

- **Household ingress, independent dispute resolution and emergency recovery
  remain separate end-state TODOs:** the design still must define how household
  evidence reaches the protocol, how a dispute involving an ISP is decided, and
  how settlement is recovered when the ISP fails a required duty. No privileged
  operator or single institution is assumed to perform all three roles.

- **Roster authenticity is an explicit ISP trust boundary:** the protocol does
  not sample subscriber records or independently verify that HCD entries
  correspond to real households, live access lines, consenting subscribers, or
  the HPCs issued by the ISP. The accepted ISP-signed HCD is authoritative for
  those roster relationships under the current design. A future protocol
  revision may reconsider this trust assumption, but no trustless roster
  mechanism is required or defined here.

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

- **Allowance hoarding can distort the ISP's internal grant allocation:** a
  household requests additional allowance while its existing allowance remains
  largely unspent, potentially leaving less room under `P` for households with
  later genuine demand; the deferred protocol-arbitrated timing audit is intended
  to establish the early requests even if the household eventually spends the
  allowance.

- **Spend-ahead consumes future allowance before the ISP grants it:** a tampered
  box signs consumption beyond the current HSAT, whether or not it has already
  requested a top-up, hoping that a later grant will make the closing total fit;
  the later grant may fund the apps but timestamped evidence preserves the
  household's temporal breach.

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

- **Epoch-opening handoff mechanics remain unsealed:** the dependency order and
  zero-default outcome are fixed, but the exact bilateral transport, delivery,
  timeout, and retry mechanics remain unspecified both for the pre-HCD HEID
  control proof and for the later activation sequence that supplies and verifies
  the box-created AtS-only ciphertext, makes the opening HSATM effective, and
  delivers the HPC. The fixed order does not make these handoffs atomic or
  introduce a new protocol message.

- **The AtS-binding challenge route and remedy remain unsealed:** the retained
  artifacts needed to prove tag-to-ciphertext substitution are defined, but the
  submission route, adjudicating actor, challenge deadline, privacy boundary,
  correction or recovery remedy, and penalty consequence remain deferred. This
  open machinery does not add a public binding set or weaken the requirement
  that every activated household's AtS entry match its jointly signed binding.

- **Pre-activation ConRec enforcement and auditability remain unsealed:** the
  design must specify the timing evidence, credential-to-consumption binding,
  and audit route needed to establish whether the mandatory HPC check preceded
  service. It must also decide how a claim backed by a pre-activation ConRec is
  treated and whether any payment or penalty consequence follows. This TODO
  introduces no new field, message, or primitive and chooses none of those
  outcomes.

- **Epoch tariff agreements still need a format and evidence specification:**
  catalogue identifiers, signatures, acceptance binding, and evidence-round
  disclosure must be specified consistently in the authoritative design and
  message catalogue.

- **The ISP credit policy still needs numerical calibration:** debt ceilings,
  debt ageing, collateral ratios, amortization schedules, commitment-adequacy
  tests, correlated-liquidity stress, and the default waterfall require pilot
  distributions and an explicit adversarial pass.

- **Dishonest-ISP analysis remains incomplete:** the design must test allowance
  shaving, dishonest refusals motivated by debt, missed debt service,
  correction-funding failure, and every remaining place where the ISP controls
  a private mapping.

- **ISP-and-app collusion still has an undefeated silent-padding form:** a
  dishonest ISP can help an accomplice app fabricate plausible household rows
  and falsify the private consumption report while suppressing the evidence
  summons that would expose the app.

- **Several future anti-collusion mechanisms remain candidates:** a public
  charged-total annex using household verification tags, trustless witness
  discovery such as broadcast evidence summons, compelled verifiable decryption,
  and random evidence sampling are not part of the current design.

- **Borrow-and-default replaces consumption-weighted allocation farming as the
  central common-fund attack:** a wash app can turn an ISP overdraft into cash,
  but the extraction becomes profitable only if the ISP can evade the resulting
  debt through default, restructuring, affiliation, or weak collateral recovery.

- **The end state needs a durable second instance:** disputes in which the ISP is
  a party cannot be judged by that ISP. The independent actor or mechanism,
  authority, interface and finality rules remain unsealed.

- **Finality and post-execution recovery remain unsealed:** the protocol still
  needs to decide an irreversibility horizon, whether later fraud can trigger
  offsets, collateral recovery, payment reversal or only external remedies, how
  later evidence is submitted and adjudicated, what public result authorizes a
  remedy, and how restitution interacts with already closed accounting.

- **Penalty enforcement remains unsealed:** slashing and expulsion remain
  intended consequences of proven misconduct and missed duties, but the design
  still needs to define the enforcing actor and mechanism, penalty amounts and
  their schedule and bounds, the authoritative finding and public record,
  collateral sizing, custody and disposition, execution timing, appeals and
  finality, and expulsion and re-entry rules. Naming those consequences does not
  itself define an additional protocol message or operation.

- **The pro-rata household-shortfall rule may be reconsidered only in a future
  revision:** ISP fronting could pay apps in full and recover from the household,
  but it is not part of the current settlement path; making the ISP an obligatory
  insurer would expose it to hacked boxes and household-app collusion.
----- END SOURCE /home/ibmko/lab/oe/materials/Whitepaper/v0.2/notes-allowance-architecture-summary.md -----
