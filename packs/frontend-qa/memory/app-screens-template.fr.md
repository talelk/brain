# Modèle des écrans d'une application : une entrée par application web

Copiez cette entrée pour chaque application web, nommez la copie `app-screens-<app>.md`, et remplacez tout ce qui est entre chevrons. Les agents de parcours trouvent ces entrées avec `memory.search` (ils cherchent « app screens » et le nom de l'application). Tant qu'une application n'a pas son entrée, un balayage hebdomadaire ne sait pas quoi visiter.

## Application

- Nom : `<nom de l'application, tel que les gens le disent>`
- Adresse : `<https://... de l'application à tester>` ; l'hôte doit être joignable depuis le sandbox, donc à lister sous `network` pour le projet
- Langues : `<anglais, français, arabe>`
- Compte de test : `<nom d'utilisateur, et nom du secret qui contient le mot de passe ; jamais le compte d'une vraie personne>`

## Écrans, dans l'ordre où un nouveau visiteur les rencontre

1. `<nom de l'écran>` : `<comment l'atteindre depuis le premier écran>` ; action principale : `<ce que fait un utilisateur ici une fois>`
2. `<nom de l'écran>` : `<comment l'atteindre>` ; action principale : `<...>`

L'image de moteur de Brain contient un navigateur (Playwright et Chromium, lancé avec `--no-sandbox`). L'adresse de l'application doit figurer dans le `network` du projet.
