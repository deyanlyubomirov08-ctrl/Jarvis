# 3D модели

Тук се слагат 3D моделите (GLB), които играта използва вместо вградените фигурки.
Списъкът е в `manifest.json`: кой файл за кого е.

| Файл | Модел в Meshy | Използва се за |
|------|---------------|----------------|
| `phantom-fiddler.glb` | The Phantom Fiddler | бардове; призраци и духове |
| `veil-of-daggers.glb` | Veil of Daggers | мошеници; култисти, вещици, убийци |
| `ragged-harvester.glb` | Ragged Harvester | зомбита, гули, скелети и друга нежит |
| `manta-dreamscape.glb` | Manta Dreamscape | летящи същества (прилепи, харпии, стирги…) |
| `ancient-sea-chariot.glb` | Ancient Sea Chariot | декор във водата на картата |

Как да добавиш модел:
1. В Meshy отвори модела → **Download** → формат **GLB** (с текстури, ако имаш).
2. Преименувай файла както е в таблицата и го сложи в тази папка (`public/models/`).
3. Презареди играта — фигурката се сменя автоматично. Ако файлът липсва, играта ползва вградената фигурка.

В `manifest.json` можеш да промениш за кого е всеки модел (`use`), височината му (`height`),
цвета, ако е без текстура (`tint`), и сиянието (`glow`). Правила в `use`:
`class:<клас>` (напр. `class:bard`), `monster:<част от име>` (напр. `monster:zombie|ghoul`),
`type:<вид>` (напр. `type:undead`) и `prop:water` за декор във водата.

## Готови безплатни модели (KayKit, CC0)

Файловете `kaykit-*.glb` са от пакетите KayKit Adventurers и KayKit Skeletons на Kay Lousberg
(https://kaylousberg.com), лиценз CC0 — свободни за всякаква употреба. Всеки има анимации
`idle`, `walk`, `attack`, `hit`, `death` (и `cast` за магьосниците), които играта пуска в битка.
Пресъздават се със `scripts/blender/prepare_kaykit.py`.
