# Mon bus

Quand partir pour le bus Citéa C2 / C5 de Pôle Bus à Briffaut (Valence), avec la carte des bus en direct.

- Horaires : GTFS Citéa (transport.data.gouv.fr), précalculés dans `data.json` par `build_data.py`.
- Temps réel : flux GTFS-RT Citéa (horaires et positions des bus).
- Météo : Open-Meteo. Fond de carte : Esri World Light Gray, Leaflet.

Mettre à jour les horaires : `python -I build_data.py`, puis publier `data.json`.
