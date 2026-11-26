# Parité de comportement : ce qu'une migration doit prouver

Une migration est terminée quand le module fait ce qu'il faisait avant et que l'enregistrement le montre. Les agents lisent cette entrée avant de changer un module et avant d'en relire un.

## Ce qui compte comme parité

1. **Les mêmes tests, au vert avant et après.** Les tests du module sont exécutés avant le changement puis de nouveau après, avec les mêmes commandes. Les deux exécutions sont enregistrées dans la tâche, avec la ligne de résumé de leur sortie.
2. **Une exécution qui exerce quelque chose.** Une exécution de zéro test n'est pas une réussite.
3. **Aucun test affaibli.** Aucun test supprimé, ignoré, assoupli ou modifié pour correspondre à la nouvelle sortie, sauf si le but dit que le comportement devait changer.
4. **L'interface publique comme avant.** Les noms exportés, les signatures, les routes, les formats de fichier et les messages restent les mêmes sauf si le but les change ; alors chaque appelant est mis à jour dans le même changement.
5. **Le comportement non testé est couvert d'abord.** Un module sans test reçoit des tests de caractérisation qui passent sur l'ancien code avant qu'on le change ; ils enregistrent ce que le code fait maintenant, pas ce qu'il devrait faire.

## Comment exécuter avant et après

- Utilisez les commandes du projet, tirées de `CLAUDE.md`, `AGENTS.md`, du README ou du manifeste.
- Exécutez les tests ciblés du module, puis le linter, la vérification de types et la suite complète quand c'est raisonnable.
- Si un test échoue déjà avant le changement, nommez-le et montrez qu'il échoue de la même façon après.

## Ce que dit le résultat

- Les commandes, dans l'ordre, chacune avec sa ligne de résumé.
- Ce qui n'a pas pu être vérifié et pourquoi.
- L'interface publique : inchangée, ou changée avec la liste des appelants mis à jour.
