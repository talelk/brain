# Politique de sécurité des dépendances

Cette entrée est la règle de tous les agents de cet espace de travail. Modifiez les valeurs pour qu'elles correspondent à l'espace ; les agents suivent ce qui est écrit ici plutôt que leur propre jugement.

## Ce qui bloque

- **Critique et élevée** dans un paquet que le code utilise : à corriger tout de suite. Une pull request est ouverte cette semaine et une personne l'approuve.
- **Moyenne** : à corriger sous 30 jours, au prochain changement prévu du projet.
- **Faible, ou un paquet que le code n'utilise pas** : listée dans le rapport hebdomadaire, aucune action requise.
- Une gravité qu'OSV ne donne pas est traitée comme **élevée** jusqu'à ce qu'une personne dise autre chose.

## Qui décide

- Une personne membre de cet espace de travail approuve toute pull request qui change une dépendance.
- Un avis qui ne peut pas être corrigé (aucune version corrigée n'existe, ou la montée de version casse le projet) demande une exception écrite, copiée de `template-security-exception`, approuvée par une personne. Jusque-là, il reste ouvert dans le rapport.

## Comment un agent prouve un constat

- Un constat nomme l'appel `osv.query` qui l'a renvoyé. Pas d'appel, pas de constat.
- « Aucun avis renvoyé pour cette version » est la seule chose qu'un agent peut dire d'un paquet sain ; il ne dit jamais « sûr ».
- Un correctif est prouvé par les tests du projet et par l'audit relancé, tous deux montrés avec leur sortie.
