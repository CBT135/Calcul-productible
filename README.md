# Calcul productible PV

Application web d'estimation de productible photovoltaïque au pas horaire, qui fonctionne entièrement dans le navigateur. Le moteur de calcul est écrit en Python (pvlib) et tourne localement grâce à [Pyodide](https://pyodide.org) : aucune donnée n'est envoyée à un serveur.

**Application en ligne :** https://cbt135.github.io/Calcul-productible/

## Utilisation

1. **Site** : saisir les coordonnées, ou cliquer sur la carte. Les liens générés ouvrent directement les données PVGIS et Global Solar Atlas pour ce point. Enregistrer chaque page (Ctrl+S / ⌘S) puis déposer le fichier dans l'application.
2. **Météo** : déposer le TMY PVGIS 5.3 (CSV ou JSON), de préférence **sans horizon** (`usehorizon=0`), le masque étant appliqué par l'application. Déposer ou coller le JSON Global Solar Atlas pour recaler le TMY (mensuel ou annuel).
3. **Masque lointain** (optionnel) : CSV `Azimut;Hauteur` (0 = Sud, Est négatif) ou fichier horizon PVGIS.
4. **Modules et onduleurs** : déposer les fichiers `.PAN` et `.OND` (format texte), puis saisir le nombre de modules en série et les groupes d'onduleurs (nombre d'onduleurs × chaînes par onduleur).
5. **Structure** (section placée avant les modules) : sheds fixes, Est-Ouest, tracker mono-axe ou **toiture** ; ombrage électrique « selon les chaînes ». Tous les azimuts sont saisis en convention **0 = Sud** (0 = Sud, Est négatif, Ouest positif) :
   - **sheds** : azimut des modules ;
   - **Est-Ouest** : orientation du faîtage. 0 = Sud, ce qui donne un pan Est à −90° et un pan Ouest à +90°. Une orientation de 20° donne −70° et +110°.

   Les projets enregistrés avant cette convention, où 180 valait Sud, sont convertis automatiquement à l'ouverture.
6. **Pertes, bifacial, thermique, P50/P90** : valeurs standard proposées, toutes modifiables. Un nouveau projet part de champs vides pour tout ce qui est propre au site (coordonnées, géométrie, câblage, transformateur) ; la simulation reste bloquée tant qu'ils ne sont pas renseignés.
7. **Lancer la simulation**, puis exporter : classeur Excel complet, rapport PDF, série horaire CSV, projet JSON (rouvrable avec toutes les saisies et tous les fichiers).

Les saisies et fichiers sont conservés dans le navigateur entre deux sessions.

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

- **Météo** : TMY PVGIS 5.3 (SARAH-3), recalage optionnel sur Global Solar Atlas. Le diffus et le direct sont multipliés séparément, mois par mois ou sur l'année. Le GHI est recomposé (DIF + DNI × cos z). Le DNI est plafonné à 1,05 × le ciel clair, avec redistribution de l'énergie écrêtée pour conserver les cumuls.
- **Masque lointain** : le direct est coupé sous la ligne d'horizon. Le diffus isotrope et la bande d'horizon sont réduits d'un facteur intégré sur la voûte céleste vue par le plan.
- **Transposition** : Perez (isotrope, circumsolaire et bande d'horizon séparés).
- **Ombrages proches** : modèle 1D de rangées infinies (`shaded_fraction1d`), première rangée non ombrée, perte de vue du ciel pour le diffus.
- **Ombrage électrique** « selon les chaînes », avec une ou plusieurs configurations (sous-chaînes en hauteur × part des tables, total 100 %). Une étude complète est calculée par configuration, puis toutes les grandeurs sont moyennées au prorata des tables. Fraction de l'effet électrique paramétrable ; les chaînes suivent les rangées. En mode « auto », on compte 2 sous-chaînes par module portrait en demi-cellules, 1 en cellules entières, et 3 par module paysage.
- **Face arrière** : pvlib *infinite sheds* (Hay-Davies), avec ombrage arrière, mismatch arrière et fraction transparente.
- **IAM** : Fresnel avec couche antireflet, ou profil utilisateur du `.PAN`.
- **Module** : modèle à une diode (`pvlib.pvsystem.calcparams_pvsyst`). Les paramètres Rs, Rsh(G), γ, μγ et μIsc sont lus dans le `.PAN`. IL et I0 sont calculés à partir d'Isc et de Voc.
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
