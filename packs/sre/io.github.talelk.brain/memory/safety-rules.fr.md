# Règles de sécurité pour toute modification de l'hôte

Ces règles s'appliquent à tous les agents de cet espace de travail, dans toutes les tâches, quel que soit l'objectif. L'évaluateur les vérifie et rejette une remédiation qui en enfreint une.

## Les trois règles

1. **Ne jamais redémarrer sans une vérification échouée observée dans cette tâche.** Un conteneur n'est redémarré, ou une pile redéployée, qu'après l'échec d'une vérification dans la tâche en cours : `http.check` a renvoyé `ok: false`, ou `host.status` a montré le conteneur arrêté, en redémarrage ou défaillant. Le signalement d'une personne, une ancienne note, une entrée de mémoire ou le résultat d'une autre tâche est une raison de vérifier, jamais une raison de redémarrer. Si la vérification réussit quand vous la lancez, ne changez rien et dites-le.

2. **Un conteneur à la fois.** Modifiez un conteneur, attendez la réponse de l'outil, relancez sa vérification, et seulement alors envisagez le suivant. Ne redémarrez jamais plusieurs conteneurs d'un coup et jamais « tout ». Si plus de trois conteneurs sont défaillants en même temps, la cause est probablement commune (le disque, le réseau, une dépendance) : arrêtez-vous, ne changez rien et signalez-le à une personne.

3. **Consigner ce qui a été vu avant et après.** Avant une modification, écrivez sur le tableau avec `task.note` la vérification échouée et ce qu'elle a renvoyé. Après, écrivez la même vérification et ce qu'elle renvoie maintenant. Une modification sans ces deux notes est considérée comme non vérifiée.

## Avant de proposer un redémarrage

- Lisez les dernières lignes du journal du conteneur. Si elles révèlent une cause qu'un redémarrage ne peut pas corriger (plus d'espace sur le disque, erreur de configuration, secret manquant, dépendance en panne), ne redémarrez pas : signalez la cause.
- Consultez `host.disk`. Un disque plein se règle par une personne, pas par un redémarrage.
- Consultez le runbook du service en mémoire pour savoir quand un redémarrage est risqué.

## Approbation

- `host.restart` et `host.redeploy` restent en attente jusqu'à ce qu'une personne approuve exactement cet appel. Appelez une fois et attendez.
- Si la réponse indique retenu, refusé ou rejeté, rien n'a été modifié. Ne répétez pas l'appel et n'essayez pas un autre outil pour obtenir le même effet. Rédigez l'étape exacte pour une personne, son risque et la façon de l'annuler.
- Ne dites qu'une modification a été faite que si la réponse de l'outil dit qu'elle s'est exécutée.

## Jamais

- Ne demandez jamais une action qu'aucun outil ne fournit : supprimer des données, des volumes ou des sauvegardes, modifier la configuration ou des secrets, toucher un autre hôte. Décrivez-la plutôt pour une personne.
- Ne recopiez jamais un mot de passe, un jeton ou une clé d'un journal dans une note, un résultat ou un message.
- Ne redémarrez jamais deux fois le même conteneur dans une tâche. Si le premier redémarrage n'a pas réglé le problème, la cause est ailleurs.
