# Comment vérifier un changement avant de demander une relecture

Un changement est prêt pour la relecture quand vous l'avez exécuté et pouvez montrer l'exécution. Le relecteur voit votre diff et les commandes enregistrées dans votre tâche ; une affirmation sans exécution enregistrée est renvoyée.

## Avant de commencer

1. Trouvez les commandes propres au projet dans `CLAUDE.md`, `AGENTS.md`, le README ou la section des scripts de son manifeste (`package.json`, `Makefile`, `pyproject.toml` et similaires). Utilisez celles-là, pas vos suppositions.
2. Exécutez une fois les tests du périmètre avant de modifier quoi que ce soit. S'ils échouent déjà, notez lesquels, pour ne pas en porter la faute ni vous en servir d'excuse.

## Pendant le travail

3. Écrivez ou mettez à jour un test qui échoue sans votre changement. Exécutez-le et vérifiez qu'il échoue pour la bonne raison, puis faites le changement et vérifiez qu'il passe.
4. Après chaque modification significative, exécutez le plus étroit qui exerce votre changement : un fichier de tests, un paquet.

## Avant de rendre votre travail

5. Exécutez, dans cet ordre, tout ce que le projet possède :
   - le formateur ou le linter ;
   - la vérification des types ou l'étape de compilation ;
   - les tests des paquets que vous avez touchés ;
   - toute la suite de tests, quand elle se termine en un temps raisonnable. Sinon, dites ce que vous avez exécuté et ce que vous avez laissé de côté.
6. Lisez la sortie. Une commande qui se termine par une erreur, affiche un avertissement qui n'existait pas avant, ou n'exécute silencieusement aucun test n'est pas une réussite.
7. Relisez votre propre `git diff` de haut en bas. Retirez les sorties de débogage, le code commenté, les fichiers parasites et les changements que vous ne vouliez pas faire.
8. Vérifiez une dernière fois le changement par rapport à l'objectif : chacune de ses parties, et rien d'autre.

## Ce qu'il faut écrire dans votre résultat

- Les commandes exactes, dans l'ordre où vous les avez exécutées.
- Pour chacune, la ligne de résumé de sa sortie : "142 passed, 0 failed", "no issues found".
- Tout test qui échoue pour une raison sans rapport avec votre changement, avec la preuve qu'il échouait déjà avant.
- Ce que vous n'avez pas pu vérifier et pourquoi (pas de réseau, pas de base de données, un test qui exige un secret).

## Jamais

- Ne dites jamais que les tests passent sans les avoir exécutés dans cette tâche.
- N'affaiblissez, ne sautez ni ne supprimez jamais un test pour faire passer la suite. Si un test est faux, dites-le et laissez le relecteur décider.
- Ne présentez jamais le résultat d'un tour précédent comme celui-ci. Exécutez de nouveau après chaque correction.
