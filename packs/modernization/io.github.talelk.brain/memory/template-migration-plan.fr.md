# Modèle de plan de migration : une entrée par migration

Copiez cette entrée une fois pour chaque migration, nommez la copie `migration-<quoi>.md` et remplacez tout ce qui est entre chevrons. Les agents trouvent ces entrées avec `memory.search` (ils cherchent « migration » et le nom de la cible), gardez donc les titres tels quels. Tant qu'une migration n'a pas sa propre entrée, les agents ne travaillent qu'à partir du but.

**Agents : cette entrée est un modèle. Ses valeurs sont des remplaçants. Ne les prenez jamais pour des faits sur un vrai projet.**

## Cible

<ce vers quoi le code évolue : framework et version, structure, langage>

## Pourquoi et quand

<la raison, et la date après laquelle l'ancienne façon n'est plus prise en charge>

## Modules, dans l'ordre

1. <chemin du module> : <risque faible, moyen ou élevé>, <comment exécuter ses tests>
2. <chemin du module> : <risque>, <comment exécuter ses tests>

## Ne doit pas changer

<interfaces publiques, routes, formats de fichier et messages dont d'autres systèmes dépendent>

## Terminé quand

<ce qui prouve que la migration est complète : tous les modules migrés, tests au vert, ancienne dépendance retirée>

## Hors périmètre

<ce qui semble lié et doit être laissé tel quel>
