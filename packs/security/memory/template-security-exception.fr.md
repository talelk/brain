# Modèle : une exception de sécurité

Copiez cette entrée une fois pour chaque avis qui ne peut pas être corrigé maintenant, nommez la copie `security-exception-<id de l'avis>.md`, et remplacez tout ce qui est entre chevrons. Les agents trouvent ces entrées avec `memory.search` (« security exception » et l'id de l'avis), et un avis qui a une exception en cours est rapporté comme accepté, pas comme ouvert.

## Avis

- **Id** : <GHSA-... ou CVE-...>
- **Paquet et version** : <nom@version>
- **Projet** : <nom du projet>
- **Gravité** : <comme OSV la donne>

## Pourquoi il ne peut pas être corrigé maintenant

<Aucune version corrigée n'existe / la montée de version casse ... / le paquet n'est pas atteignable parce que ...>

## Ce qui limite le risque entre-temps

<Un contrôle en place, écrit comme un fait vérifiable.>

## Approbation

- **Approuvé par** : <le nom d'une personne>
- **Date** : <AAAA-MM-JJ>
- **À revoir avant le** : <AAAA-MM-JJ, au plus 90 jours plus tard>
