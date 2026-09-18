# Crates — iOS distribution

Workstream 3 research. Current as of 2026-09-17. All figures verified against
the sources linked at the bottom; Apple and Expo change pricing, so re-check
before spending money.

## TL;DR

- **You do not need a Mac.** EAS Build compiles iOS apps on Expo-hosted macOS
  VMs. You drive the whole thing from Windows with `npx eas-cli`. This is the
  single most important finding and it is unambiguous.
- **You do need $99/yr.** Apple Developer Program membership is mandatory for
  TestFlight *and* the App Store. There is no free path onto a phone other than
  a 7-day sideload, which is not viable for this project.
- **EAS free tier is enough** for this app's build volume (15 iOS builds/month),
  at the cost of sitting in a low-priority queue.
- **The biggest App Store risk is not technical.** It is Guideline 4.2 (an app
  that is one person's static dataset is "minimum functionality") and Guideline
  5.2.2 (you must be permitted by the data provider's terms). See
  `DATA_SOURCES.md` — those two questions are coupled.

---

## 1. The real sequence: Expo project → TestFlight → App Store

```
Expo project (Windows)
   └─ eas build --platform ios        → build runs on Expo's macOS VM
        └─ .ipa produced, signed with your Apple credentials
             └─ eas submit --platform ios  → uploads to App Store Connect
                  └─ processing (~5-30 min) + export-compliance answer
                       ├─ Internal TestFlight  → testers get it in minutes
                       └─ External TestFlight  → Beta App Review (~1-2 days)
                            └─ App Store submission → full App Review
                                 └─ Release (manual or automatic)
```

Concretely, in order:

1. **Enroll in the Apple Developer Program** (below). Nothing downstream works
   until this is active. Start it first — it is the only step with a multi-day
   tail you cannot compress.
2. **Create the app record in App Store Connect** with a bundle identifier
   (e.g. `com.yourname.crates`). Done in a browser on Windows.
3. **Configure `app.json` / `eas.json`** in the Expo project: set
   `ios.bundleIdentifier` to exactly that string, set `version` and
   `ios.buildNumber`.
4. **`eas build --platform ios --profile production`.** The first run asks you
   to sign in with your Apple ID; EAS then creates the Distribution Certificate
   and Provisioning Profile for you via App Store Connect's API and stores them
   on Expo's servers.
5. **`eas submit --platform ios`.** Uploads the `.ipa` to App Store Connect.
6. **TestFlight internal testing.** Add yourself (and up to 99 others) as
   internal testers. No review. Install within minutes.
7. **TestFlight external testing** (optional, and only if you want testers
   outside your App Store Connect team). Requires Beta App Review.
8. **App Store submission.** Fill in the listing: screenshots for required
   device sizes, description, keywords, support URL, privacy policy URL, App
   Privacy "nutrition label" answers, age rating, and export compliance.
9. **App Review.** Typically 24–48 hours in practice. Approve → release.

Steps 3–5 you can fully automate from Windows. Steps 1, 2, 8 are browser work
in your own Apple account. Step 9 is Apple's.

## 2. Apple Developer Program

| | Individual | Organization |
|---|---|---|
| Cost | **$99 USD/year** | **$99 USD/year** (same) |
| Seller name on App Store | Your **legal personal name** | Company name |
| Requires | Apple Account with 2FA, legal age of majority, government ID | All that **plus a D-U-N-S number**, a legal entity, a public website on a matching domain, and authority to bind the entity |
| Typical verification time | **24–48 hours** | **1–2 weeks** (D-U-N-S alone can take days if you don't have one) |
| Team members | Just you | Multiple roles |

For this project: **enroll as an Individual.** The only real cost is that your
personal name is public as the seller. Organization enrollment buys you nothing
here and adds a D-U-N-S dependency that will stall you for a week or more.

Notes:
- The fee is annual and auto-renews. Let it lapse and your apps are removed
  from the App Store and TestFlight builds stop working.
- Fee waivers exist for nonprofits, accredited educational institutions and
  government entities. Not applicable here.
- Enrollment can be started in the Apple Developer app on an iPhone or on the
  web. The iPhone route often clears ID verification faster.

## 3. EAS Build

**What it is.** Expo Application Services' hosted build service. You run a CLI
command locally; EAS provisions a fresh macOS VM with Xcode and Fastlane
installed, checks out your project, installs dependencies, runs the native
build, signs the binary with your credentials, and hands you a downloadable
`.ipa`. `eas submit` then pushes it to App Store Connect.

### Can you build for iOS from Windows? Yes.

This is the critical constraint and the answer is clean. Per Expo's own iOS
build reference: every build gets its own fresh macOS VM with all build tools
installed *there*. Your machine only needs Node and `eas-cli`. Windows, Linux,
a Chromebook — irrelevant. The compilation, code signing and keychain work all
happen on Expo's Macs.

Caveats, stated precisely so you are not surprised:

- **Cloud builds only.** `eas build --local` — the free local-build escape
  hatch — *does* require macOS for iOS. That option is closed to you. You must
  use the hosted service, and the free tier's quota is therefore a real ceiling.
- **You cannot run the iOS Simulator on Windows.** Debugging against a real
  iOS runtime means either Expo Go / a development build on a physical iPhone,
  or nothing. Plan on testing on a real device.
- **Some App Store Connect steps still want a browser**, not a Mac. Fine on
  Windows.
- There is no step in this pipeline that requires you to own Apple hardware
  other than an iPhone to run the app on.

### Pricing (current)

| Plan | Price/month | Included | Concurrency | Queue |
|---|---|---|---|---|
| **Free** | $0 | **15 iOS + 15 Android builds/month** | 1 | Low priority — can wait 90+ min at peak |
| Starter | $19 + usage | $45 build credit | 1 (+$50/extra) | High priority |
| Production | $199 + usage | $225 build credit | 2 (+$50/extra) | High priority |
| Enterprise | custom | $1,000+ credit | 5+ | High priority |

Beyond quota, individual build jobs run roughly **$1–$4** depending on platform
and worker size.

**Does the free tier suffice for Crates? Yes, comfortably.** You need one build
to get onto TestFlight and a handful more per release. 15 iOS builds/month is
far more than a solo project ships. The only thing you are buying at $19/mo is
not waiting in the queue. Recommendation: **start on Free.** If queue waits
become genuinely annoying during an active push, one month of Starter is a
cheap, cancellable fix. Do not pre-pay for Production.

Also note EAS Update (over-the-air JS updates) is included in the free tier up
to 1,000 monthly active users — relevant later, because it lets you push
JS-only fixes without a new App Store review.

## 4. Bundle IDs, certificates, provisioning profiles

The division of labour:

**Tooling handles (EAS, automatically, from Windows):**
- Generating the **iOS Distribution Certificate** (the signing identity).
- Generating and maintaining the **App Store Provisioning Profile**.
- Storing both encrypted on Expo's servers and installing them into a keychain
  on the build VM.
- Re-generating them when they expire or when the bundle ID changes.
- Registering device UDIDs, for internal-distribution (ad-hoc) profiles.
- Uploading the finished build (`eas submit`).

To do this, EAS asks for your Apple ID at first build. Preferably give it an
**App Store Connect API key** instead (App Store Connect → Users and Access →
Integrations → Keys) — it avoids handing over your Apple ID password and 2FA,
and it is what you want for any automation.

**You must do yourself, in your Apple account:**
- Enrol and pay.
- **Choose the bundle identifier.** Reverse-DNS, e.g. `com.yourname.crates`.
  It is **permanent** — once a build is uploaded under it you cannot rename it,
  and it must be globally unique across all of Apple. Pick carefully now.
- Create the App Store Connect app record and reserve the app name.
- Accept Apple's Program License Agreement and any updated agreements (App
  Store Connect will silently block submissions until you do — a very common
  cause of "why is my build stuck").
- Complete tax/banking forms — **required even for a free app** before it can
  be distributed; the free-apps agreement must be active.
- Answer App Privacy questions and provide a privacy policy URL.

Rule of thumb: **certificates and profiles are not your problem; agreements,
identifiers and metadata are.**

## 5. TestFlight specifics

| | Internal | External |
|---|---|---|
| Max testers | **100** per app | **10,000** per app |
| Who they are | Members of your App Store Connect team | Anyone, by email invite or a **public link** |
| Beta App Review | **Not required** | **Required** for the first build of each new version number |
| Availability | Minutes after processing | After review passes (typically ~1–2 days for the first one) |
| Devices per tester | Up to 30 | Up to 30 |

- **Builds expire after 90 days.** When a build expires, testers lose access
  entirely — the app stops launching. For a long-lived beta you must upload a
  fresh build at least quarterly.
- Internal testers need to be added as users on your team, which means each one
  consumes an App Store Connect seat and gets an email invitation.
- Subsequent builds of the *same* version number generally skip external review;
  bumping the version number triggers review again.
- Beta App Review is lighter than App Review but applies the same guidelines.
  If your app would be rejected from the App Store, it will usually be caught
  here first — which is useful: **use external TestFlight as an early
  guideline check.**

**For Crates specifically:** internal-only TestFlight is almost certainly all
you need, and it has no review at all. That is the fastest realistic path to
"this is on my phone." Treat App Store release as a separate, later decision.

## 6. App Store review considerations for THIS app

Flagging honestly, worst first.

### High risk

1. **Guideline 4.2 — Minimum Functionality.** This is the most likely rejection.
   As specced, Crates ships a static `collection.json` generated from *one
   person's* Last.fm export. To a reviewer, that is a single-user personal
   project with no functionality for anyone else who downloads it. Apple
   explicitly rejects apps that are "not useful, unique, or app-like" and apps
   that amount to a personal utility. **A shipped app must let an arbitrary
   user connect their own account and see their own crates.** Without that,
   plan on 4.2 rejection. This is exactly why Question 2 matters — see
   `DATA_SOURCES.md`.

2. **Guideline 5.2.2 — Third-Party Sites/Services.** If the app uses, accesses,
   or displays content from a third-party service, you must be *specifically
   permitted to do so under that service's terms*. Reviewers do check. If you
   ship on Spotify's Web API outside the terms it grants you, or on Last.fm's
   API without a commercial agreement while monetizing, this is a rejection and
   potentially an API ban. `DATA_SOURCES.md` covers exactly what each provider
   permits.

3. **Cover art and metadata rights.** Album artwork is licensed material.
   Serving it from MusicBrainz/Cover Art Archive is generally fine; serving
   Spotify cover art requires attribution and a link back to Spotify, and
   Spotify forbids offering metadata or cover art "as a standalone service."
   A wall of album covers with no other function is close to that line.

### Medium risk

4. **Sign in with Apple (4.8).** If you add third-party login (Spotify OAuth,
   Last.fm auth) as the *only* sign-in method, Apple may require you to also
   offer an equivalent privacy-preserving login option. Reading a username with
   no account creation sidesteps this; a real OAuth login does not.

5. **App Privacy label + privacy policy.** You will be collecting listening
   history, which Apple classifies as sensitive usage data. You need a hosted
   privacy policy URL (a GitHub Pages page is acceptable) and accurate answers
   about what you collect, whether it leaves the device, and whether it is
   linked to identity. Mismatches between the label and observed network
   traffic are a rejection.

6. **Account deletion (5.1.1(v)).** If the app supports account creation, it
   must offer in-app account deletion. Avoid creating accounts and this
   disappears.

7. **Demo credentials.** Reviewers must be able to see the full app. If content
   is gated behind a Spotify/Last.fm login, you must supply working test
   credentials in App Review notes — and if your data source is limited to an
   allowlist of users (Spotify dev mode!), **the reviewer's account will not
   work and you will be rejected.** This is a concrete, frequently-hit trap.

### Low risk

8. Naming: don't call it "Spotify Crates" or start the name with "Spot".
   Don't imply endorsement. Don't use Spotify's green or its logo as your icon.
9. Games/gamification: the "unlock" mechanic is fine — Spotify's policy forbids
   building *games or trivia* on their content, which a collection-completion
   view is not, but keep it framed as a stats/collection view rather than a game.
10. Screenshots must not show Apple hardware inaccurately or contain placeholder
    content.

**Bottom line on review:** TestFlight-internal is basically risk-free and you
should go there now. App Store release is gated on solving the multi-user data
problem, not on anything about the build pipeline.

## 7. Your checklist — what you personally must do, in order

| # | Step | Where | Cost | Time |
|---|---|---|---|---|
| 1 | Turn on two-factor auth for your Apple Account; have a government ID ready | appleid.apple.com | $0 | 10 min |
| 2 | **Enrol in the Apple Developer Program as an Individual** | developer.apple.com/programs/enroll | **$99/yr** | 15 min + 24–48 h wait |
| 3 | Accept the Program License Agreement and complete the **Free Apps** agreement + tax forms | App Store Connect → Business | $0 | 20 min |
| 4 | Decide and record the permanent bundle ID (e.g. `com.yourname.crates`) | — | $0 | 5 min |
| 5 | Create the app record and reserve the app name | App Store Connect → Apps → + | $0 | 10 min |
| 6 | Create an **App Store Connect API key** (Integrations → Keys, Admin role) and save the `.p8` | App Store Connect | $0 | 5 min |
| 7 | Create a free Expo account | expo.dev | **$0** (Free tier) | 2 min |
| 8 | `npm i -g eas-cli && eas login && eas build:configure` | Your Windows terminal | $0 | 10 min |
| 9 | `eas build --platform ios --profile production` — hand it the API key when prompted; let it generate certs and profiles | Windows | $0 (within 15/mo) | 20–90 min queue+build |
| 10 | `eas submit --platform ios` | Windows | $0 | 10 min |
| 11 | Answer export-compliance ("does your app use encryption" → standard HTTPS only) | App Store Connect | $0 | 2 min |
| 12 | Add yourself as an **internal TestFlight tester**; install TestFlight on your iPhone; install the build | App Store Connect + iPhone | $0 | 15 min |
| 13 | **STOP HERE if the goal is "on my phone."** Re-upload a build every ~90 days before expiry | — | $0 | recurring |
| 14 | Before App Store: solve multi-user data (see `DATA_SOURCES.md`), publish a privacy policy URL, prepare screenshots, description, keywords, support URL | — | $0 | a day |
| 15 | Complete App Privacy answers; submit for App Review with reviewer demo credentials that actually work | App Store Connect | $0 | 1 h + 24–48 h review |
| 16 | Optional, only if queue waits hurt: one month of EAS Starter | expo.dev | $19/mo | — |

**Total unavoidable cash cost to get this on your phone via TestFlight:
$99/year. Nothing else.**

## Sources

- [Apple Developer Program — enroll](https://developer.apple.com/programs/enroll/)
- [Apple Developer Program — membership details](https://developer.apple.com/programs/whats-included/)
- [TestFlight — Apple Developer](https://developer.apple.com/testflight/)
- [App Review Guidelines](https://developer.apple.com/app-store/review/guidelines/)
- [Expo — iOS build process reference](https://docs.expo.dev/build-reference/ios-builds/)
- [Expo — subscriptions, plans and add-ons](https://docs.expo.dev/billing/plans/)
- [Expo — usage-based pricing](https://docs.expo.dev/billing/usage-based-pricing/)
- [Expo pricing page](https://expo.dev/pricing)
- [TestFlight distribution guide — internal vs external and review](https://techconcepts.org/blog/testflight-guide)
