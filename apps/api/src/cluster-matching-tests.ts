#!/usr/bin/env tsx

import assert from "node:assert/strict";

import { buildSignature, isSignatureCompatible } from "./ai-embed-cluster.js";

function test(name: string, fn: () => void) {
  try {
    fn();
    console.log(`ok - ${name}`);
  } catch (error) {
    console.error(`not ok - ${name}`);
    throw error;
  }
}

test("matches aliens confirmation contracts across venues", () => {
  const polymarket = buildSignature({
    eventTitle: "Will the US confirm that aliens exist by...?",
    marketTitle: "December 31",
    eventCategory: "politics",
    marketCategory: "politics",
    dates: ["2026-12-31T00:00:00Z"],
  });
  const kalshi = buildSignature({
    eventTitle: "Will the U.S. confirm that aliens exist before 2027?",
    marketTitle: "Before 2027",
    eventCategory: "politics",
    marketCategory: "politics",
    dates: ["2026-12-31T00:00:00Z"],
  });

  assert.equal(isSignatureCompatible(polymarket, kalshi), true);
});

test("rejects aliens confirmation vs Jesus return", () => {
  const aliens = buildSignature({
    eventTitle: "Will the U.S. confirm that aliens exist before 2027?",
    marketTitle: "Before 2027",
    eventCategory: "politics",
    marketCategory: "politics",
    dates: ["2026-12-31T00:00:00Z"],
  });
  const jesus = buildSignature({
    eventTitle: "Will Jesus Christ return before 2027?",
    marketTitle: "Will Jesus Christ return before 2027?",
    eventCategory: "culture",
    marketCategory: "culture",
    dates: ["2026-12-31T00:00:00Z"],
  });

  assert.equal(isSignatureCompatible(aliens, jesus), false);
});

test("matches Greenland acquisition contracts across venues", () => {
  const polymarket = buildSignature({
    eventTitle: "Will Trump acquire Greenland before 2027?",
    marketTitle: "Will Trump acquire Greenland before 2027?",
    eventCategory: "politics",
    marketCategory: "politics",
    dates: ["2026-12-31T00:00:00Z"],
  });
  const limitless = buildSignature({
    eventTitle: "Will Trump acquire Greenland before 2027?",
    marketTitle: "Will Trump acquire Greenland before 2027?",
    eventCategory: "politics",
    marketCategory: "politics",
    dates: ["2026-12-31T00:00:00Z"],
  });

  assert.equal(isSignatureCompatible(polymarket, limitless), true);
});

test("rejects Greenland acquisition vs Iran regime fall", () => {
  const greenland = buildSignature({
    eventTitle: "Will Trump acquire Greenland before 2027?",
    marketTitle: "Will Trump acquire Greenland before 2027?",
    eventCategory: "politics",
    marketCategory: "politics",
    dates: ["2026-12-31T00:00:00Z"],
  });
  const iran = buildSignature({
    eventTitle: "Will the Iranian regime fall by March 31?",
    marketTitle: "Will the Iranian regime fall by March 31?",
    eventCategory: "politics",
    marketCategory: "politics",
    dates: ["2026-03-31T00:00:00Z"],
  });

  assert.equal(isSignatureCompatible(greenland, iran), false);
});

test("rejects Greenland acquisition vs Trump coin launch deadline", () => {
  const greenland = buildSignature({
    eventTitle: "Will Trump acquire Greenland before 2027?",
    marketTitle: "Will Trump acquire Greenland before 2027?",
    eventCategory: "politics",
    marketCategory: "politics",
    dates: ["2026-12-31T00:00:00Z"],
  });
  const coin = buildSignature({
    eventTitle: "Will Trump launch a coin by ___?",
    marketTitle: "December 31, 2026",
    eventCategory: "politics",
    marketCategory: "politics",
    dates: ["2026-12-31T00:00:00Z"],
  });

  assert.equal(isSignatureCompatible(greenland, coin), false);
});

test("rejects different military-action subjects", () => {
  const taiwan = buildSignature({
    eventTitle: "Will China invade Taiwan by end of 2026?",
    marketTitle: "Will China invade Taiwan by end of 2026?",
    eventCategory: "politics",
    marketCategory: "politics",
    dates: ["2026-12-31T00:00:00Z"],
  });
  const iran = buildSignature({
    eventTitle: "Will the U.S. invade Iran by March 31?",
    marketTitle: "Will the U.S. invade Iran by March 31?",
    eventCategory: "politics",
    marketCategory: "politics",
    dates: ["2026-03-31T00:00:00Z"],
  });

  assert.equal(isSignatureCompatible(taiwan, iran), false);
});

test("rejects Chelsea vs Port Vale against unrelated Italy halftime match", () => {
  const chelsea = buildSignature({
    eventTitle: "Chelsea FC vs. Port Vale FC - Halftime Result",
    marketTitle: "Port Vale FC",
    eventCategory: "sports",
    marketCategory: "sports",
    dates: ["2026-04-04T00:00:00Z"],
  });
  const italy = buildSignature({
    eventTitle: "Will Italy lead at halftime vs Northern Ireland on Mar 26?",
    marketTitle: "Will Italy lead at halftime vs Northern Ireland on Mar 26?",
    eventCategory: "sports",
    marketCategory: "sports",
    dates: ["2026-03-26T00:00:00Z"],
  });

  assert.equal(isSignatureCompatible(chelsea, italy), false);
});

test("rejects Thorin analyst market vs Team Vitality results", () => {
  const thorin = buildSignature({
    eventTitle: "Will Thorin appear as an analyst at an S-Tier CS tournament in 2026?",
    marketTitle: "Will Thorin appear as an analyst at an S-Tier CS tournament in 2026?",
    eventCategory: "sports",
    marketCategory: "sports",
    dates: ["2026-12-31T00:00:00Z"],
  });
  const vitality = buildSignature({
    eventTitle: "Will Team Vitality win ESL Grand Slam VI by May 31?",
    marketTitle: "Will Team Vitality win ESL Grand Slam VI by May 31?",
    eventCategory: "sports",
    marketCategory: "sports",
    dates: ["2026-05-31T00:00:00Z"],
  });

  assert.equal(isSignatureCompatible(thorin, vitality), false);
});

test("rejects mention market vs unrelated event-final outcome market", () => {
  const blastQuote = buildSignature({
    eventTitle: "What will be said during the BLAST Premier Open Rotterdam 2026 Grand Final?",
    marketTitle: "IGL",
    eventCategory: "sports",
    marketCategory: "sports",
    dates: ["2026-03-29T00:00:00Z"],
  });
  const draculanFinal = buildSignature({
    eventTitle: "Will fnatic reach the Upper final at DraculaN Season 6?",
    marketTitle: "Will fnatic reach the Upper final at DraculaN Season 6?",
    eventCategory: "sports",
    marketCategory: "sports",
    dates: ["2026-03-29T00:00:00Z"],
  });

  assert.equal(isSignatureCompatible(blastQuote, draculanFinal), false);
});

test("rejects unrelated competition advancement markets", () => {
  const fnaticFinal = buildSignature({
    eventTitle: "Will fnatic reach the Upper final at DraculaN Season 6?",
    marketTitle: "Will fnatic reach the Upper final at DraculaN Season 6?",
    eventCategory: "sports",
    marketCategory: "sports",
    dates: ["2026-03-29T00:00:00Z"],
  });
  const agFinal = buildSignature({
    eventTitle: "Will AG Super Play reach the Grand Final in KPL Spring 2026?",
    marketTitle: "Will AG Super Play reach the Grand Final in KPL Spring 2026?",
    eventCategory: "sports",
    marketCategory: "sports",
    dates: ["2026-03-29T00:00:00Z"],
  });

  assert.equal(isSignatureCompatible(fnaticFinal, agFinal), false);
});

test("rejects same player across different opponents in match-result markets", () => {
  const paulVsFils = buildSignature({
    eventTitle: "Paul vs Fils",
    marketTitle: "Arthur Fils",
    eventCategory: "sports",
    marketCategory: "sports",
    dates: ["2026-03-27T00:00:00Z"],
  });
  const filsVsTsitsipas = buildSignature({
    eventTitle: "Fils vs Tsitsipas",
    marketTitle: "Arthur Fils",
    eventCategory: "sports",
    marketCategory: "sports",
    dates: ["2026-03-26T00:00:00Z"],
  });

  assert.equal(isSignatureCompatible(paulVsFils, filsVsTsitsipas), false);
});

test("rejects match result vs yellow-card prop for the same fixture", () => {
  const result = buildSignature({
    eventTitle: "Italy vs Northern Ireland",
    marketTitle: "Italy",
    eventCategory: "sports",
    marketCategory: "sports",
    dates: ["2026-03-26T00:00:00Z"],
  });
  const yellowCards = buildSignature({
    eventTitle: "Will either team receive 3+ yellow cards in Italy vs N. Ireland?",
    marketTitle:
      "Will either team receive 3+ yellow cards in Italy vs N. Ireland?",
    eventCategory: "sports",
    marketCategory: "sports",
    dates: ["2026-03-26T00:00:00Z"],
  });

  assert.equal(isSignatureCompatible(result, yellowCards), false);
});

test("rejects match result vs red-card prop for the same fixture", () => {
  const result = buildSignature({
    eventTitle: "Southampton FC vs. Arsenal FC",
    marketTitle: "Southampton FC",
    eventCategory: "sports",
    marketCategory: "sports",
    dates: ["2026-04-04T00:00:00Z"],
  });
  const redCard = buildSignature({
    eventTitle: "Will any player get a red card in Southampton vs Arsenal on April 4?",
    marketTitle:
      "Will any player get a red card in Southampton vs Arsenal on April 4?",
    eventCategory: "sports",
    marketCategory: "sports",
    dates: ["2026-04-04T00:00:00Z"],
  });

  assert.equal(isSignatureCompatible(result, redCard), false);
});

test("rejects match result vs same-fixture shots-on-target prop", () => {
  const result = buildSignature({
    eventTitle: "Manchester City FC vs. Liverpool FC",
    marketTitle: "Manchester City FC",
    eventCategory: "sports",
    marketCategory: "sports",
    dates: ["2026-04-04T00:00:00Z"],
  });
  const shotsOnTarget = buildSignature({
    eventTitle:
      "Will Man City make 3 or less SoT in 1st half vs Liverpool on April 4?",
    marketTitle:
      "Will Man City make 3 or less SoT in 1st half vs Liverpool on April 4?",
    eventCategory: "sports",
    marketCategory: "sports",
    dates: ["2026-04-04T00:00:00Z"],
  });

  assert.equal(isSignatureCompatible(result, shotsOnTarget), false);
});

test("rejects match result vs both-teams-to-score prop", () => {
  const result = buildSignature({
    eventTitle: "Manchester City FC vs. Liverpool FC",
    marketTitle: "Manchester City FC",
    eventCategory: "sports",
    marketCategory: "sports",
    dates: ["2026-04-04T00:00:00Z"],
  });
  const bothTeamsToScore = buildSignature({
    eventTitle: "Manchester City FC vs. Liverpool FC - More Markets",
    marketTitle: "Both Teams to Score",
    eventCategory: "sports",
    marketCategory: "sports",
    dates: ["2026-04-04T00:00:00Z"],
  });

  assert.equal(isSignatureCompatible(result, bothTeamsToScore), false);
});

test("rejects match result vs same-fixture possession prop", () => {
  const result = buildSignature({
    eventTitle: "Denmark vs. North Macedonia",
    marketTitle: "North Macedonia",
    eventCategory: "sports",
    marketCategory: "sports",
    dates: ["2026-03-26T00:00:00Z"],
  });
  const possession = buildSignature({
    eventTitle:
      "Will Denmark have 60%+ possession vs N. Macedonia on Mar 26?",
    marketTitle:
      "Will Denmark have 60%+ possession vs N. Macedonia on Mar 26?",
    eventCategory: "sports",
    marketCategory: "sports",
    dates: ["2026-03-26T00:00:00Z"],
  });

  assert.equal(isSignatureCompatible(result, possession), false);
});

test("rejects match result vs same-fixture VAR prop", () => {
  const result = buildSignature({
    eventTitle: "Ukraine vs. Sweden",
    marketTitle: "Ukraine",
    eventCategory: "sports",
    marketCategory: "sports",
    dates: ["2026-03-26T00:00:00Z"],
  });
  const varCheck = buildSignature({
    eventTitle:
      "Will Ukraine vs Sweden match have a VAR goal check on March 26?",
    marketTitle:
      "Will Ukraine vs Sweden match have a VAR goal check on March 26?",
    eventCategory: "sports",
    marketCategory: "sports",
    dates: ["2026-03-26T00:00:00Z"],
  });

  assert.equal(isSignatureCompatible(result, varCheck), false);
});

test("rejects election winner markets across different countries", () => {
  const hungary = buildSignature({
    eventTitle: "Hungary Parliamentary Election Winner",
    marketTitle: "Jobbik",
    eventCategory: "politics",
    marketCategory: "politics",
    dates: ["2026-04-12T00:00:00Z"],
  });
  const scotland = buildSignature({
    eventTitle: "Scotland Parliamentary Election Winner",
    marketTitle: "Scottish National Party",
    eventCategory: "politics",
    marketCategory: "politics",
    dates: ["2026-05-07T00:00:00Z"],
  });

  assert.equal(isSignatureCompatible(hungary, scotland), false);
});

test("rejects election winner vs office-holder-after-election markets", () => {
  const winner = buildSignature({
    eventTitle: "Hungary Parliamentary Election Winner",
    marketTitle: "Jobbik",
    eventCategory: "politics",
    marketCategory: "politics",
    dates: ["2026-04-12T00:00:00Z"],
  });
  const officeHolder = buildSignature({
    eventTitle: "Prime Minister of Hungary after the 2026 election?",
    marketTitle: "Viktor Orbán",
    eventCategory: "politics",
    marketCategory: "politics",
    dates: ["2027-05-01T00:00:00Z"],
  });

  assert.equal(isSignatureCompatible(winner, officeHolder), false);
});

test("rejects layoffs trend vs company deliveries threshold", () => {
  const layoffs = buildSignature({
    eventTitle: "More tech layoffs in 2026 than in 2025?",
    marketTitle: "Yes",
    eventCategory: "technology",
    marketCategory: "technology",
    dates: ["2026-12-31T00:00:00Z"],
  });
  const deliveries = buildSignature({
    eventTitle: "Tesla deliveries in Q1 2026?",
    marketTitle: "340000 or more",
    eventCategory: "technology",
    marketCategory: "technology",
    dates: ["2026-03-31T00:00:00Z"],
  });

  assert.equal(isSignatureCompatible(layoffs, deliveries), false);
});

test("rejects price-level markets across different assets", () => {
  const bitcoin = buildSignature({
    eventTitle: "What price will Bitcoin hit in March?",
    marketTitle: "↑ 150,000",
    eventCategory: "crypto",
    marketCategory: "crypto",
    dates: ["2026-03-31T00:00:00Z"],
  });
  const ethereum = buildSignature({
    eventTitle: "What price will Ethereum hit in March?",
    marketTitle: "↑ 4,000",
    eventCategory: "crypto",
    marketCategory: "crypto",
    dates: ["2026-03-31T00:00:00Z"],
  });
  const bnb = buildSignature({
    eventTitle: "BNB above $645.54 on Mar 26, 16:00 UTC?",
    marketTitle: "BNB above $645.54 on Mar 26, 16:00 UTC?",
    eventCategory: "crypto",
    marketCategory: "crypto",
    dates: ["2026-03-26T16:00:00Z"],
  });

  assert.equal(isSignatureCompatible(bitcoin, ethereum), false);
  assert.equal(isSignatureCompatible(bitcoin, bnb), false);
});

test("rejects price markets across different underlyings with shared currency units", () => {
  const kospi = buildSignature({
    eventTitle: "Will KOSPI (KS11) close above __ end of Q1?",
    marketTitle: "5000",
    eventCategory: "economics",
    marketCategory: "economics",
    dates: ["2026-03-31T00:00:00Z"],
  });
  const kosdaq = buildSignature({
    eventTitle: "Will KOSDAQ be above 1,159.61 KRW on March 27?",
    marketTitle: "Will KOSDAQ be above 1,159.61 KRW on March 27?",
    eventCategory: "economics",
    marketCategory: "economics",
    dates: ["2026-03-27T00:00:00Z"],
  });

  assert.equal(isSignatureCompatible(kospi, kosdaq), false);
});

test("rejects season champion vs single-race winner on shared participant name", () => {
  const seasonChampion = buildSignature({
    eventTitle: "F1 Drivers' Champion",
    marketTitle: "Franco Colapinto",
    eventCategory: "sports",
    marketCategory: "sports",
    dates: ["2026-12-06T00:00:00Z"],
  });
  const raceWinner = buildSignature({
    eventTitle: "Chinese Grand Prix: Sprint Race Winner",
    marketTitle: "Franco Colapinto",
    eventCategory: "sports",
    marketCategory: "sports",
    dates: ["2026-03-28T00:00:00Z"],
  });

  assert.equal(isSignatureCompatible(seasonChampion, raceWinner), false);
});

test("rejects season champion vs conference champion", () => {
  const seasonChampion = buildSignature({
    eventTitle: "2026 NBA Champion",
    marketTitle: "Golden State Warriors",
    eventCategory: "sports",
    marketCategory: "sports",
    dates: ["2026-06-30T00:00:00Z"],
  });
  const conferenceChampion = buildSignature({
    eventTitle: "NBA Eastern Conference Champion",
    marketTitle: "Boston Celtics",
    eventCategory: "sports",
    marketCategory: "sports",
    dates: ["2026-06-01T00:00:00Z"],
  });

  assert.equal(isSignatureCompatible(seasonChampion, conferenceChampion), false);
});

test("rejects tournament winner vs group winner", () => {
  const worldCupWinner = buildSignature({
    eventTitle: "2026 FIFA World Cup Winner",
    marketTitle: "Jordan",
    eventCategory: "sports",
    marketCategory: "sports",
    dates: ["2026-07-31T00:00:00Z"],
  });
  const groupWinner = buildSignature({
    eventTitle: "FIFA World Cup Group B Winner",
    marketTitle: "Qatar",
    eventCategory: "sports",
    marketCategory: "sports",
    dates: ["2026-06-20T00:00:00Z"],
  });

  assert.equal(isSignatureCompatible(worldCupWinner, groupWinner), false);
});

test("rejects drivers champion vs constructors champion", () => {
  const driversChampion = buildSignature({
    eventTitle: "F1 Drivers' Champion",
    marketTitle: "Franco Colapinto",
    eventCategory: "sports",
    marketCategory: "sports",
    dates: ["2026-12-06T00:00:00Z"],
  });
  const constructorsChampion = buildSignature({
    eventTitle: "F1 Constructors Champion",
    marketTitle: "Red Bull Racing",
    eventCategory: "sports",
    marketCategory: "sports",
    dates: ["2026-12-06T00:00:00Z"],
  });

  assert.equal(isSignatureCompatible(driversChampion, constructorsChampion), false);
});

test("rejects stanley cup winner vs division winner for same team", () => {
  const stanleyCup = buildSignature({
    eventTitle: "2026 Stanley Cup Champion",
    marketTitle: "Colorado Avalanche",
    eventCategory: "sports",
    marketCategory: "sports",
    dates: ["2026-06-20T00:00:00Z"],
  });
  const centralDivision = buildSignature({
    eventTitle: "Central Division Winner",
    marketTitle: "Colorado Avalanche",
    eventCategory: "sports",
    marketCategory: "sports",
    dates: ["2026-04-15T00:00:00Z"],
  });

  assert.equal(isSignatureCompatible(stanleyCup, centralDivision), false);
});

test("rejects win title vs make final markets for same team", () => {
  const winTitle = buildSignature({
    eventTitle: "Who will win the national championship?",
    marketTitle: "Arkansas",
    eventCategory: "sports",
    marketCategory: "sports",
    dates: ["2026-04-07T00:00:00Z"],
  });
  const makeFinal = buildSignature({
    eventTitle: "Will Arkansas make the national championship?",
    marketTitle: "Yes",
    eventCategory: "sports",
    marketCategory: "sports",
    dates: ["2026-04-07T00:00:00Z"],
  });

  assert.equal(isSignatureCompatible(winTitle, makeFinal), false);
});

test("rejects month-specific Fed decision markets across different meetings", () => {
  const april = buildSignature({
    eventTitle: "Fed decision in April?",
    marketTitle: "50+ bps decrease",
    eventCategory: "economics",
    marketCategory: "economics",
    dates: ["2026-04-29T00:00:00Z"],
  });
  const june = buildSignature({
    eventTitle: "Fed decision in Jun 2026?",
    marketTitle: "Cut 25bps",
    eventCategory: "economics",
    marketCategory: "economics",
    dates: ["2026-06-01T00:00:00Z"],
  });

  assert.equal(isSignatureCompatible(april, june), false);
});

test("rejects same-month Fed decision markets across different years", () => {
  const april2026 = buildSignature({
    eventTitle: "Fed decision in Apr 2026?",
    marketTitle: "Fed maintains rate",
    eventCategory: "economics",
    marketCategory: "economics",
    dates: ["2026-04-29T00:00:00Z"],
  });
  const april2027 = buildSignature({
    eventTitle: "Fed decision in Apr 2027?",
    marketTitle: "Hike 25bps",
    eventCategory: "economics",
    marketCategory: "economics",
    dates: ["2027-04-29T00:00:00Z"],
  });

  assert.equal(isSignatureCompatible(april2026, april2027), false);
});

test("rejects month-specific price hit windows vs broad yearly price windows", () => {
  const marchBitcoin = buildSignature({
    eventTitle: "What price will Bitcoin hit in March?",
    marketTitle: "↑ 150,000",
    eventCategory: "crypto",
    marketCategory: "crypto",
    dates: ["2026-03-31T00:00:00Z"],
  });
  const yearlyBitcoin = buildSignature({
    eventTitle: "How high will Bitcoin get in 2026?",
    marketTitle: "Above $99,999.99",
    eventCategory: "crypto",
    marketCategory: "crypto",
    dates: ["2026-12-31T00:00:00Z"],
  });
  const byDeadlineBitcoin = buildSignature({
    eventTitle: "Will Bitcoin be above $200k by 2027?",
    marketTitle: "Above $200000",
    eventCategory: "crypto",
    marketCategory: "crypto",
    dates: ["2027-12-31T00:00:00Z"],
  });

  assert.equal(isSignatureCompatible(marchBitcoin, yearlyBitcoin), false);
  assert.equal(isSignatureCompatible(marchBitcoin, byDeadlineBitcoin), false);
});

test("rejects yearly layoffs trend vs specific-month layoffs trend", () => {
  const yearly = buildSignature({
    eventTitle: "More tech layoffs in 2026 than in 2025?",
    marketTitle: "Yes",
    eventCategory: "technology",
    marketCategory: "technology",
    dates: ["2026-12-31T00:00:00Z"],
  });
  const monthly = buildSignature({
    eventTitle: "Tech Layoffs Up or Down in February, 2026?",
    marketTitle: "Tech Layoffs Up or Down in February, 2026?",
    eventCategory: "technology",
    marketCategory: "technology",
    dates: ["2026-02-28T00:00:00Z"],
  });

  assert.equal(isSignatureCompatible(yearly, monthly), false);
});

test("rejects office-exit markets across mismatched horizons", () => {
  const before2027 = buildSignature({
    eventTitle: "Trump out as President before 2027?",
    marketTitle: "Trump out as President before 2027?",
    eventCategory: "politics",
    marketCategory: "politics",
    dates: ["2027-01-01T00:00:00Z"],
  });
  const march31 = buildSignature({
    eventTitle: "Trump out as President by March 31?",
    marketTitle: "Trump out as President by March 31?",
    eventCategory: "politics",
    marketCategory: "politics",
    dates: ["2026-03-31T00:00:00Z"],
  });

  assert.equal(isSignatureCompatible(before2027, march31), false);
});

test("rejects price threshold point-in-time vs weekly range contract", () => {
  const threshold = buildSignature({
    eventTitle: "NVIDIA (NVDA) closes above ___ on March 26?",
    marketTitle: "$165",
    eventCategory: "economics",
    marketCategory: "economics",
    dates: ["2026-03-26T00:00:00Z"],
  });
  const weeklyRange = buildSignature({
    eventTitle: "NVIDIA (NVDA) closes week of Mar 23 at ___?",
    marketTitle: "$170-$175",
    eventCategory: "economics",
    marketCategory: "economics",
    dates: ["2026-03-27T00:00:00Z"],
  });

  assert.equal(isSignatureCompatible(threshold, weeklyRange), false);
});

test("rejects price threshold quarter horizon vs daily point-in-time", () => {
  const quarterEnd = buildSignature({
    eventTitle: "Will KOSPI (KS11) close above __ end of Q1?",
    marketTitle: "5000",
    eventCategory: "economics",
    marketCategory: "economics",
    dates: ["2026-03-31T00:00:00Z"],
  });
  const daily = buildSignature({
    eventTitle: "Will KOSPI be above 5,594.06 KRW on March 27?",
    marketTitle: "Will KOSPI be above 5,594.06 KRW on March 27?",
    eventCategory: "economics",
    marketCategory: "economics",
    dates: ["2026-03-27T00:00:00Z"],
  });

  assert.equal(isSignatureCompatible(quarterEnd, daily), false);
});

test("rejects territorial-acquisition markets with different yearly horizon shapes", () => {
  const before2027 = buildSignature({
    eventTitle: "Will Trump acquire Greenland before 2027?",
    marketTitle: "Will Trump acquire Greenland before 2027?",
    eventCategory: "politics",
    marketCategory: "politics",
    dates: ["2027-01-01T00:00:00Z"],
  });
  const in2026 = buildSignature({
    eventTitle: "Will the US acquire part of Greenland in 2026?",
    marketTitle: "Will the US acquire part of Greenland in 2026?",
    eventCategory: "politics",
    marketCategory: "politics",
    dates: ["2026-12-31T00:00:00Z"],
  });

  assert.equal(isSignatureCompatible(before2027, in2026), false);
});

test("rejects winner markets with different selections despite overlapping event words", () => {
  const houstonOpen = buildSignature({
    eventTitle: "Texas Children's Houston Open Winner?",
    marketTitle: "Brooks Koepka",
    eventCategory: "sports",
    marketCategory: "sports",
    dates: ["2026-03-30T00:00:00Z"],
  });
  const veoliaOpen = buildSignature({
    eventTitle: "Veolia Texas Open (Mixed Doubles) Winner",
    marketTitle: "Anna Leigh Waters / Ben Johns",
    eventCategory: "sports",
    marketCategory: "sports",
    dates: ["2026-03-30T00:00:00Z"],
  });

  assert.equal(isSignatureCompatible(houstonOpen, veoliaOpen), false);
});

test("rejects presidential nominee vs vice presidential nominee", () => {
  const president = buildSignature({
    eventTitle: "2028 Democratic nominee for President?",
    marketTitle: "Gavin Newsom",
    eventCategory: "politics",
    marketCategory: "politics",
    dates: ["2028-11-01T00:00:00Z"],
  });
  const vicePresident = buildSignature({
    eventTitle: "Who will be the Democratic VP nominee in 2028?",
    marketTitle: "Gavin Newsom",
    eventCategory: "politics",
    marketCategory: "politics",
    dates: ["2028-11-01T00:00:00Z"],
  });

  assert.equal(isSignatureCompatible(president, vicePresident), false);
});

test("rejects actual nominee markets vs candidate-entry markets", () => {
  const nominee = buildSignature({
    eventTitle: "Republican Presidential Nominee 2028",
    marketTitle: "Byron Donalds",
    eventCategory: "politics",
    marketCategory: "politics",
    dates: ["2028-11-07T00:00:00Z"],
  });
  const entry = buildSignature({
    eventTitle: "Who will run for the Republican presidential nomination in 2028?",
    marketTitle: "Byron Donalds",
    eventCategory: "politics",
    marketCategory: "politics",
    dates: ["2028-11-07T00:00:00Z"],
  });

  assert.equal(isSignatureCompatible(nominee, entry), false);
});

test("rejects yearly layoffs trend vs quarterly layoffs trend", () => {
  const yearly = buildSignature({
    eventTitle: "More tech layoffs in 2026 than in 2025?",
    marketTitle: "Yes",
    eventCategory: "economics",
    marketCategory: "economics",
    dates: ["2026-12-31T00:00:00Z"],
  });
  const quarter = buildSignature({
    eventTitle: "Tech Layoffs Up or Down in Q1, 2026?",
    marketTitle: "Tech Layoffs Up or Down in Q1, 2026?",
    eventCategory: "economics",
    marketCategory: "economics",
    dates: ["2026-03-31T00:00:00Z"],
  });

  assert.equal(isSignatureCompatible(yearly, quarter), false);
});
