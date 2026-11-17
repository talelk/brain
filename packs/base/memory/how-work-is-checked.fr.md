# Comment le travail est vérifié et approuvé dans Brain

Cette entrée s'adresse aux agents. Elle explique ce qui arrive à votre résultat après que vous l'avez rendu, afin que vous y laissiez ce dont la vérification a besoin.

## Chaque résultat est vérifié par quelqu'un d'autre

Une tâche n'est terminée qu'une fois son résultat vérifié par autre chose que l'agent qui l'a produit : le relecteur nommé par l'étape du Play, l'agent `checker`, ou une personne. Vous ne vérifiez jamais votre propre résultat.

La vérification reçoit l'objectif de la tâche, votre résultat, chaque appel d'outil enregistré pendant le travail avec son entrée et sa sortie, ainsi que le diff de la copie de travail. Elle répond par réussite ou échec, parfois avec un score, et avec des constats.

- Réussite : la tâche est terminée, ou passe à une personne quand l'étape demande une validation.
- Échec : vous êtes relancé avec les constats. Corrigez exactement ceux-là. Après le nombre de tours autorisé, la tâche passe à une personne.

## Ce que la vérification recherche

- Chaque chose demandée par l'objectif est présente dans le résultat.
- Chaque affirmation importante est étayée par une preuve enregistrée dans cette tâche : la sortie d'un outil, une commande que vous avez lancée, un fichier que vous avez écrit, des lignes du diff.
- Rien n'est affirmé qui ne se soit produit. « Les tests passent » exige l'exécution des tests enregistrée. « Redémarré » exige la réponse de l'outil lui-même. Un fait sur un système réel exige un appel d'outil qui l'a lu.

Donc : lancez la commande plutôt que de prédire sa sortie, citez la ligne qui compte et dites d'où vient chaque fait. Quand vous n'avez pas pu faire ou vérifier quelque chose, dites-le clairement ; une lacune assumée coûte moins cher qu'une vérification échouée.

## Les actions hors du bac à sable demandent une personne

Les outils de lecture s'exécutent aussitôt. Un outil qui modifie quelque chose hors de votre bac à sable (une pull request, un message, un redémarrage) reste en attente jusqu'à ce qu'une personne approuve exactement cet appel, sauf si l'espace de travail détient une approbation permanente qui le couvre.

- Appelez-le une fois et attendez ; l'approbation peut prendre plusieurs minutes.
- Si la réponse indique retenu, refusé ou rejeté, l'action n'a pas eu lieu. Ne la répétez pas et ne cherchez pas un autre moyen. Indiquez qu'elle n'a pas été faite et ce qu'une personne devrait faire.
- Ne dites qu'une action a eu lieu que si la réponse de l'outil lui-même dit qu'elle s'est exécutée.

## Validation

Certaines étapes demandent aussi la validation d'une personne une fois la vérification réussie. Rédigez le résultat de façon qu'une personne qui n'a pas suivi le travail puisse décider à partir de lui : ce qui a été fait, ce qui a été vérifié et comment, et ce qui reste ouvert.
