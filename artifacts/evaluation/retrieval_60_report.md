# Retrieval Generalization Evaluation

- Final untouched test: 60 opponents, 100 games each, split 64 train / 16 tune / 20 test.
- Frozen settings: retrieval weight 0.25, bucket weight 0, k=3, distance threshold 0.15.
- Tuning set: 3,635 middlegame positions across the first 20 opponents; accuracy 48.56%.
- Final retrieval coverage: 1,083 / 14,793 middlegame positions (7.32%).
- Median player middlegame delta: 0.00 pp; 17 improved, 19 tied, 24 regressed.

## Aggregate accuracy

| Phase | Positions | Base Maia | Opening tree | 4-bucket | Retrieval |
|---|---:|---:|---:|---:|---:|
| Opening (<12) | 7,053 | 35.56% | 55.99% | 55.99% | 55.99% |
| Middlegame (12–40) | 14,793 | 50.53% | 50.53% | 50.53% | 50.48% |
| Endgame (>40) | 15,913 | 55.74% | 55.74% | 55.74% | 55.74% |
| **Overall** | **37,759** | **49.93%** | **53.75%** | **53.75%** | **53.72%** |

## Per-player middlegame top-1

| Maia4All ID | Opponent | Positions | Base Maia | Retrieval | Delta |
|---:|---|---:|---:|---:|---:|
| 0 | aliafrooz | 235 | 47.66% | 47.66% | 0.00 pp |
| 1 | Anush_Borse | 227 | 52.86% | 51.54% | -1.32 pp |
| 2 | hempatel3215 | 217 | 50.69% | 50.69% | 0.00 pp |
| 3 | Jasmine-Jane | 249 | 51.41% | 51.81% | +0.40 pp |
| 4 | josueg12chess | 230 | 47.83% | 48.26% | +0.43 pp |
| 5 | kamallllll | 244 | 46.72% | 46.72% | 0.00 pp |
| 6 | Madi_bugg | 231 | 51.08% | 50.65% | -0.43 pp |
| 7 | mhdaaqil | 223 | 41.70% | 41.70% | 0.00 pp |
| 8 | MolyGreaseNinja | 271 | 46.13% | 46.13% | 0.00 pp |
| 9 | pawnstorm22 | 216 | 55.09% | 52.78% | -2.31 pp |
| 10 | punjablion | 204 | 54.41% | 53.43% | -0.98 pp |
| 11 | remoon74 | 266 | 45.49% | 45.49% | 0.00 pp |
| 12 | samguerra | 216 | 43.06% | 42.59% | -0.46 pp |
| 13 | Shiningknight8 | 194 | 58.25% | 58.76% | +0.52 pp |
| 14 | Tomorrow_Never_Knows | 187 | 32.09% | 32.09% | 0.00 pp |
| 15 | Alkaly1982 | 215 | 47.44% | 48.84% | +1.40 pp |
| 16 | ArshavirAghaei1396 | 239 | 50.21% | 49.79% | -0.42 pp |
| 17 | DharmenderArora_77 | 200 | 43.50% | 43.50% | 0.00 pp |
| 18 | Emmitt1 | 239 | 51.88% | 51.46% | -0.42 pp |
| 19 | Gagik20130614 | 232 | 53.45% | 53.02% | -0.43 pp |
| 20 | GeneralBlather | 264 | 49.62% | 48.86% | -0.76 pp |
| 21 | Lucyfer874 | 206 | 51.46% | 52.43% | +0.97 pp |
| 22 | mahmoud5468 | 225 | 50.67% | 50.67% | 0.00 pp |
| 23 | OmerBasar | 247 | 52.23% | 51.42% | -0.81 pp |
| 24 | resloz | 247 | 56.68% | 55.47% | -1.21 pp |
| 25 | Santanahxcx | 238 | 48.74% | 49.16% | +0.42 pp |
| 26 | Toinouh | 247 | 49.80% | 49.80% | 0.00 pp |
| 27 | Tuul4 | 242 | 50.83% | 50.41% | -0.41 pp |
| 28 | Voxcaeli | 240 | 54.17% | 53.75% | -0.42 pp |
| 30 | albinlearning | 273 | 57.14% | 56.78% | -0.37 pp |
| 31 | beatatitiledoplayer | 248 | 48.79% | 49.19% | +0.40 pp |
| 33 | Felipe80rodrigues | 275 | 48.73% | 48.00% | -0.73 pp |
| 34 | Ichselber | 256 | 54.30% | 53.91% | -0.39 pp |
| 35 | ItalianGambit | 250 | 52.00% | 52.00% | 0.00 pp |
| 36 | Luan_e | 264 | 45.45% | 46.21% | +0.76 pp |
| 37 | natalMO | 269 | 43.12% | 43.87% | +0.74 pp |
| 38 | opyegor | 282 | 55.32% | 55.32% | 0.00 pp |
| 39 | prostoAndrew | 266 | 49.25% | 49.25% | 0.00 pp |
| 40 | Sadinb | 273 | 43.96% | 43.96% | 0.00 pp |
| 41 | sainis | 247 | 46.96% | 46.96% | 0.00 pp |
| 42 | sarao1415 | 266 | 54.14% | 54.14% | 0.00 pp |
| 43 | Shashank-karkare | 280 | 49.64% | 49.29% | -0.36 pp |
| 44 | ted206 | 254 | 46.46% | 46.46% | 0.00 pp |
| 45 | AleksandrVasilyev | 272 | 48.53% | 48.16% | -0.37 pp |
| 46 | Aura_smart_homes | 277 | 50.90% | 50.54% | -0.36 pp |
| 47 | giogiogiogiogio | 290 | 52.07% | 51.72% | -0.34 pp |
| 48 | IamAaravthegoat | 246 | 61.38% | 62.20% | +0.81 pp |
| 49 | joesnooze | 225 | 49.78% | 50.67% | +0.89 pp |
| 50 | Jrussell8 | 258 | 50.78% | 51.16% | +0.39 pp |
| 51 | Juan2012l | 251 | 53.78% | 53.78% | 0.00 pp |
| 52 | Karzan12 | 262 | 46.56% | 47.33% | +0.76 pp |
| 53 | Matvei4 | 264 | 53.79% | 53.79% | 0.00 pp |
| 54 | mehrzad_Ghanbari | 257 | 51.75% | 51.36% | -0.39 pp |
| 55 | SaidevsGambit | 255 | 51.37% | 52.94% | +1.57 pp |
| 57 | stw_097 | 248 | 50.40% | 50.00% | -0.40 pp |
| 58 | sushanpanguluri | 268 | 59.33% | 58.58% | -0.75 pp |
| 59 | yusufekici0734 | 271 | 57.56% | 57.93% | +0.37 pp |
| 60 | D_Daniel | 241 | 51.45% | 51.87% | +0.41 pp |
| 61 | eagle727 | 261 | 54.41% | 55.56% | +1.15 pp |
| 62 | fibonacci1123 | 253 | 52.17% | 51.38% | -0.79 pp |

## Decision

Do not ship retrieval yet. Median per-player delta is not positive, 24 of 60 players regressed, and only 7.32% of middlegame positions had a legal neighbor match. The tuned profile selected no separate bucket mixture (weight 0). More history per player or a more useful similarity representation is needed before this retrieval approach is reliable.
