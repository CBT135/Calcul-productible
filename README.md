# Calcul productible PV

Application web d'estimation de productible photovoltaïque au pas horaire, qui fonctionne entièrement dans le navigateur. Le moteur de calcul est écrit en Python (pvlib) et tourne localement grâce à [Pyodide](https://pyodide.org) : aucune donnée n'est envoyée à un serveur.

**Application en ligne :** https://cbt135.github.io/Calcul-productible/

## Utilisation

1. **Site** : saisir les coordonnées, ou cliquer sur la carte. Les liens générés ouvrent directement les données PVGIS et Global Solar Atlas pour ce point. Enregistrer chaque page (Ctrl+S / ⌘S) puis déposer le fichier dans l'application.
2. **Météo** : déposer le TMY PVGIS 5.3 (CSV ou JSON), de préférence **sans horizon** (`usehorizon=0`), le masque étant appliqué par l'application. Le TMY peut être recalé, au pas mensuel ou annuel (avec ou sans la température), sur une base de référence :
   - **Global Solar Atlas** : déposer ou coller le JSON ;
   - **base météo mensuelle** : déposer un CSV de moyennes mensuelles long terme, par exemple Solargis Prospect « LTA P1M » au format PVsyst, ou tout CSV avec une colonne `Month` et des colonnes GHI, DIF (ou DHI) et T. Au dépôt, le recalage sur cette base est coché et celui sur Global Solar Atlas décoché.

   Une seule base sert au recalage. Les cumuls sont en kWh/m² ; des valeurs journalières (moins de 12 kWh/m²) sont converties en cumuls mensuels. Les valeurs restent modifiables dans le tableau.
3. **Masque lointain** (optionnel) : CSV `Azimut;Hauteur` (0 = Sud, Est négatif) ou fichier horizon PVGIS.
4. **Modules et onduleurs** : déposer les fichiers `.PAN` et `.OND` (format texte), puis saisir le nombre de modules en série et les groupes d'onduleurs (nombre d'onduleurs × chaînes par onduleur).
5. **Structure** (section placée avant les modules) : sheds fixes, Est-Ouest, tracker mono-axe ou **toiture** ; ombrage électrique « selon les chaînes ». Tous les azimuts sont saisis en convention **0 = Sud** (0 = Sud, Est négatif, Ouest positif) :
   - **sheds** : azimut des modules ;
   - **Est-Ouest** : orientation du faîtage. 0 = Sud, ce qui donne un pan Est à −90° et un pan Ouest à +90°. Une orientation de 20° donne −70° et +110°.

   Les projets enregistrés avant cette convention, où 180 valait Sud, sont convertis automatiquement à l'ouverture.
6. **Pertes, bifacial, thermique, P50/P90** : valeurs standard proposées, toutes modifiables. Un nouveau projet part de champs vides pour tout ce qui est propre au site (coordonnées, géométrie, câblage, transformateur) ; la simulation reste bloquée tant qu'ils ne sont pas renseignés.
7. **Lancer la simulation**, puis exporter : classeur Excel complet, rapport PDF, série horaire CSV, projet JSON (rouvrable avec toutes les saisies et tous les fichiers).

Les saisies et fichiers sont conservés dans le navigateur entre deux sessions.

## Importer une étude PVsyst

Le bouton **Import PVsyst**, entre « Nouveau » et « Ouvrir », crée un projet à partir d'un rapport de simulation PVsyst en PDF (versions 7 et 8, rapport en anglais). Le texte du PDF est lu dans le navigateur avec pdf.js, et aucun fichier n'est transmis.

**Ce qui est repris :**
- **Projet et site** : projet, variante, coordonnées, altitude, albédo.
- **Structure** :
  - sheds : inclinaison, azimut, entraxe, largeur sensible, hauteur, nombre de rangées, chaînes dans la largeur, effet électrique ;
  - tracker : axe, angle maximal, backtracking, entraxe, largeur, hauteur d'axe ;
  - Est-Ouest (« Dome ») : inclinaison et orientation du faîtage ;
  - plans fixes sans scène 3D : un champ de toiture par sous-champ.
- **Champ et onduleurs** : modules en série, chaînes, onduleurs (répartis en groupes), limite d'injection, modèles et noms des fichiers .PAN et .OND.
- **Bifacial** : bifacialité, albédo du sol, ombrage et mismatch arrière, transparence.
- **Thermique et IAM** : Uc, Uv, IAM Fresnel.
- **Pertes** : salissure, LID, qualité, mismatch, pertes ohmiques DC et AC, ligne HTA, transformateur, auxiliaires, indisponibilité.
- **Horizon** : profil du masque, s'il figure dans le rapport.
- **Météo et résultats** : bilan météo mensuel, utilisable comme base de recalage du TMY, et résultats PVsyst (productible, énergie, PR, bilan mensuel).

Une fenêtre récapitule ce qui a été lu et ce qui reste à vérifier ou à compléter, avant de créer le projet. Il faut ensuite déposer le TMY PVGIS, le .PAN et le .OND, absents du rapport. Après la simulation, l'onglet Synthèse compare les résultats à ceux de l'étude PVsyst : productible, énergie, PR, irradiations, puis énergie mois par mois.

Limites :
- les modules dans la largeur des tables sont déduits de la largeur sensible ;
- la géométrie des chapelles Est-Ouest n'apparaît pas sans scène 3D ;
- un IAM défini par l'utilisateur dans PVsyst n'est pas repris.

## Simuler un extrait météo (exploitation)

Le bouton **Simuler un extrait météo**, à droite de « Lancer la simulation », compare la production mesurée sur une courte période à la simulation du projet, calculée avec les mesures météo du site. Il ne demande pas de TMY : seuls le site, le `.PAN`, le `.OND` et les saisies du projet sont nécessaires.

1. Choisir le fuseau horaire des données (heure légale française, UTC, UTC+1, UTC+2), la convention d'horodatage (début ou fin de période), le plan du capteur GTI (plan des modules, tracker, pan Est ou Ouest, horizontal ou autre plan) et le point de mesure de la production (point d'injection ou sortie des onduleurs).
2. Déposer le fichier Excel ou CSV : la simulation démarre aussitôt. Un modèle vierge est téléchargeable (`modele_extrait_meteo.xlsx`).

| Colonne | |
|---|---|
| Date et heure | obligatoire (une colonne, ou une colonne date et une colonne heure) |
| GTI (W/m²) | irradiance mesurée dans le plan du capteur ; à défaut, GHI obligatoire |
| GHI, DHI (W/m²) | facultatifs ; le DHI mesuré améliore la décomposition |
| T ambiante (°C) | obligatoire |
| Vent (m/s) | facultatif (1 m/s par défaut) |
| Énergie mesurée (kWh) | facultative ; ou « Puissance mesurée (kW) », moyenne sur le pas |

Les noms de colonnes sont reconnus automatiquement (GTI, POA, irradiance plan, température ambiante, production kWh…), ainsi que les séparateurs `;` ou `,` et les décimales à virgule. Les pas de 1 à 60 min sont ramenés à l'heure (moyennes ; énergies cumulées, complétées au prorata si l'heure est incomplète).

**Méthode** :
- **Décomposition** :
  - GTI seul : GTI-DIRINT (Marion 2015) ;
  - GTI + DHI : inversion de la transposition isotrope ;
  - GHI seul : Erbs ;
  - GHI + DHI : direct déduit.
- **Calage** : le direct et le diffus sont ensuite calés heure par heure pour retrouver exactement le GTI mesuré.
- **Hypothèses propres à l'extrait** : le masque lointain n'est pas appliqué, puisque le capteur le voit déjà. Il n'y a pas de recalage Global Solar Atlas, et l'indisponibilité est mise à 0 %. Toutes les autres pertes du projet sont conservées.

**Résultats** :
- énergie simulée et mesurée, rapport mesuré / simulé ;
- heures d'arrêt probable (production mesurée < 5 % du simulé) et rapport hors arrêts ;
- PR mesuré et simulé sur l'irradiation mesurée ;
- courbe horaire, bilan journalier et diagramme de pertes de la période ;
- export Excel et CSV horaire.

## Vérifications de dimensionnement

| Vérification | Règle | Effet |
|---|---|---|
| Tension à vide des chaînes à −10 °C | Ns × Voc(−10 °C) ≤ tension max. onduleur (`VAbsMax`) | **Bloquant** |
| Tension MPP des chaînes à 60 °C | Ns × Vmp(60 °C, 1 000 W/m²) ≥ tension MPPT mini (`VMppMin`) | Alerte |
| Courant DC | chaînes par onduleur × Isc ≤ courant DC max. (`IMaxDC`) | Alerte |

### Toiture

- **Champs** : un champ par pan de toit (bouton « + Ajouter un toit »). Chaque champ a son inclinaison, son orientation (0 = Sud, Est < 0), sa zone de calepinage (longueur horizontale × hauteur selon la pente), sa pose (portrait ou paysage) et l'espacement entre modules.
- **Relevé sur vue aérienne** : un clic dans l'orientation, la longueur ou la hauteur d'un champ (ou le bouton « Vue aérienne ») ouvre les photographies aériennes IGN centrées sur le site, avec zoom à la molette. On clique ensuite quatre points :
  1. bord bas gauche ;
  2. bord bas droit ;
  3. bord haut droit ;
  4. bord haut gauche.

  La zone est rendue rectangulaire. La longueur est la distance 1-2, l'orientation est perpendiculaire à 1-2 (face vers le bas de pente), et la hauteur en plan est ramenée selon la pente avec l'inclinaison. À la fermeture, l'inclinaison, l'orientation, la longueur et la hauteur du champ sont renseignées, et le relevé est mémorisé. « Saisir à la main » désactive l'ouverture automatique pour ce champ.
- **Calepinage** : l'application propose le nombre de modules à l'horizontale et à la verticale, et donc la puissance posable, à partir des dimensions du module affecté. Ces nombres peuvent être forcés.
- **Affectation** : chaque champ reçoit un module et un onduleur, choisis parmi le fichier principal et les fichiers supplémentaires (« + Ajouter un module / un onduleur »), ainsi que son câblage (modules en série, nombre d'onduleurs, chaînes par onduleur). Le nombre de modules câblés est comparé au calepinage : un dépassement bloque la simulation, un manque déclenche une alerte.
- **Ombrages** : il n'y a pas d'ombrage entre rangées, et tout ce qui est derrière le plan des modules est masqué. Chaque champ peut recevoir son propre masque proche (CSV `Azimut;Hauteur`), qui s'ajoute au masque lointain.
- **Calcul** : une simulation complète par champ. Les énergies sont additionnées et les grandeurs spécifiques sont moyennées au prorata de la puissance (productible, PR, irradiations, pertes). Le transformateur, les auxiliaires et la limite d'injection sont répartis au prorata de la puissance AC des champs.
- **Valeurs par défaut au passage en toiture** : effet électrique 100 %, bifacial décoché, Uc = 20 W/m²K, pas de transformateur, ligne HTA à 0 %, pas d'auxiliaires.

## Méthode de calcul (pas horaire)

- **Météo** : TMY PVGIS 5.3 (SARAH-3), recalage optionnel sur Global Solar Atlas ou sur une base météo mensuelle (Solargis…). Le diffus est multiplié mois par mois (ou sur l'année). Le direct est ajusté sur l'indice de clarté kb = DNI / DNI ciel clair, transformé en kb^g : les heures claires restent claires et les heures couvertes restent couvertes, seules les heures intermédiaires s'éclaircissent ou s'assombrissent. Une simple multiplication du direct gonflait les heures déjà claires jusqu'au plafond de ciel clair et surestimait l'écrêtage onduleur. Le GHI est recomposé (DIF + DNI × cos z). Le DNI est plafonné à 1,05 × le ciel clair, avec redistribution de l'énergie écrêtée pour conserver les cumuls.
- **Masque lointain** : le direct est coupé sous la ligne d'horizon. Le diffus isotrope et la bande d'horizon sont réduits d'un facteur intégré sur la voûte céleste vue par le plan.
- **Transposition** : Perez (isotrope, circumsolaire et bande d'horizon séparés).
- **Ombrages proches** : modèle 1D de rangées infinies (`shaded_fraction1d`), première rangée non ombrée, perte de vue du ciel pour le diffus.
- **Ombrage électrique** « selon les chaînes », avec une ou plusieurs configurations (sous-chaînes en hauteur × part des tables, total 100 %). Une étude complète est calculée par configuration, puis toutes les grandeurs sont moyennées au prorata des tables. Fraction de l'effet électrique paramétrable ; les chaînes suivent les rangées. En mode « auto », on compte 2 sous-chaînes par module portrait en demi-cellules, 1 en cellules entières, et 3 par module paysage.
- **Face arrière** : modèle 2D de rangées infinies à **sol non uniforme**, pour toutes les structures (sheds, Est-Ouest, tracker) :
  - en Est-Ouest, les deux pans sont modélisés dos à dos (chapelles) : le pan opposé fait de l'ombre au sol et masque la vue de la face arrière ;
  - le sol entre deux rangées est découpé en 40 bandes, éclairées ou à l'ombre heure par heure selon la position du soleil (la fraction transparente laisse passer une part du direct) ;
  - chaque bande reçoit le direct si elle est au soleil, plus le diffus du ciel pondéré par sa vue du ciel ;
  - la face arrière voit chaque bande et le ciel selon des facteurs de vue calculés par lancer de rayons, avec 12 rangées de part et d'autre ; pour un tracker, les facteurs sont tabulés tous les 2° d'angle de rotation ;
  - le diffus du ciel est séparé à la manière de Hay-Davies : la part circumsolaire suit l'ombre portée des rangées comme le direct, la part isotrope est pondérée par la vue du ciel ;
  - sont appliqués ensuite l'albédo, l'IAM de la face arrière (calculé pour une surface inclinée de 180° − inclinaison, qui voit le sol presque de face), le direct éventuel sur la face arrière, l'ombrage arrière et le mismatch arrière.

  L'ancien calcul (sol moyen uniforme) surestimait la face arrière, surtout pour les trackers.
- **IAM** : Fresnel avec couche antireflet, ou profil utilisateur du `.PAN`.
- **Module** : modèle à une diode (`pvlib.pvsystem.calcparams_pvsyst`). Les paramètres Rs, Rsh(G), γ, μγ et μIsc sont lus dans le `.PAN`. IL et I0 sont calculés à partir d'Isc et de Voc.
- **Faible éclairement** : le modèle à une diode peut être calé sur les rendements relatifs déclarés dans le `.PAN`, c'est-à-dire les points de fonctionnement à 25 °C (1100, 800, 600, 400, 200, 100 W/m²) ou les champs `RelEffic`. La puissance est alors multipliée par (1 + rendement relatif du .PAN) / (1 + rendement relatif du modèle), interpolé selon l'irradiance. Trois modes sont proposés dans la section Modules :
  - **automatique** (par défaut) : calage seulement si le `.PAN` contient un jeu de mesures, c'est-à-dire un point de référence marqué `True` avec Voc et Isc renseignés (fichiers de laboratoire). Sinon, les points déclarés sont en général recalculés par le modèle lui-même, et le modèle brut est conservé ;
  - **toujours** : calage dès que des points sont présents ;
  - **jamais** : modèle à une diode brut.
- **Thermique** : bilan thermique Uc / Uv (absorption du `.PAN`).
- **Pertes DC** : LID, qualité, mismatch des modules et des chaînes, pertes ohmiques proportionnelles au courant.
- **Onduleurs** : courbes Pin→Pout du `.OND` aux trois tensions, interpolées sur la tension MPP du champ. Sont aussi pris en compte : le seuil de démarrage, la sortie de plage MPPT basse, et la Pmax déclassée selon la température ambiante + **offset** (TPMax → TPNom → TPLim1 → TPLimAbs).
- **AC et système** : auxiliaires, pertes ohmiques AC et ligne HTA (quadratiques), transformateur (fer 24 h/24 ou non, cuivre quadratique), limite d'injection, indisponibilité.
- **PR** : E_grid / (GlobInc × P_nom STC), avec GlobInc calculé avant le masque lointain.
- **P50 / P90** : σ = racine de la somme des carrés des incertitudes, Px = P50 × (1 − z<sub>x</sub> σ). La variabilité météo interannuelle est calculée à partir du CSV « Monthly data » de PVGIS (écart-type / moyenne des années complètes) s'il est fourni.

## Structure du dépôt

| Fichier | Rôle |
|---|---|
| `index.html`, `style.css`, `app.js` | Interface (saisie, résultats, graphiques, exports) |
| `worker.js` | Chargement de Pyodide, pvlib et openpyxl ; appels du moteur |
| `engine/productible.py` | Moteur de calcul Python, utilisable aussi hors navigateur |

### Utiliser le moteur en Python

```python
import productible as P
files = dict(tmy=open('tmy.json').read(), tmy_name='tmy.json', pan=open('module.PAN').read(),
             ond=open('onduleur.OND').read(), horizon=open('masque.csv').read(), gsa=open('gsa.json').read())
res = P.simulate({'site': {'lat': 45.0034, 'lon': 0.0174, 'alt': 34}}, files)
print(res['summary']['yield_kwh_kwc'], res['p90']['p90'])
open('resultats.xlsx', 'wb').write(P.export_xlsx(res))
```

Dépendances : `pvlib>=0.13`, `numpy`, `pandas`, `scipy`, `openpyxl`.

## Projet test

`exemples/St-Seurin_Var0.json` est un projet de test, à ouvrir avec le bouton **Ouvrir** après l'avoir téléchargé. Il s'agit d'une centrale au sol de 2 229 kWc en sheds fixes 16° plein sud, bifaciale. L'ombrage électrique y est réparti en deux configurations : 6 sous-chaînes en hauteur sur 86,72 % des tables, 1 sous-chaîne sur 13,28 %. Le fichier contient le TMY PVGIS sans horizon, l'horizon PVGIS, les données mensuelles PVGIS et les valeurs Global Solar Atlas. Les fichiers .PAN et .OND ne sont pas publiés : il faut les déposer.

## Licence et crédits

Code publié sous [licence MIT](LICENSE) © 2026 Cédric Brachet – SAS CELLS.

Les composants tiers sont détaillés dans la page [Crédits et licences](credits.html) :
- **Bibliothèques** : pvlib, NumPy, pandas, SciPy et h5py (BSD 3-Clause) ; Pyodide (MPL 2.0) ; openpyxl et Chart.js (MIT) ; Leaflet (BSD 2-Clause) ; police Inter (OFL).
- **Données** :
  - PVGIS © Union européenne (JRC) ;
  - Global Solar Atlas 2.0 © Solargis / World Bank Group (CC BY 4.0) ;
  - fonds de carte © IGN – Géoplateforme (Licence ouverte Etalab) et © OpenStreetMap (ODbL).

Les résultats sont indicatifs et fournis sans garantie.
