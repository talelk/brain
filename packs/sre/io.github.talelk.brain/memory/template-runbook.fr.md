# Modèle de runbook : une entrée par service

Copiez cette entrée une fois pour chaque service de l'hôte, nommez la copie `runbook-<service>.md` et remplacez tout ce qui est entre chevrons. Les agents trouvent ces entrées avec `memory.search` (ils cherchent « runbook », « health address » et le nom du service) ; gardez donc les titres tels quels. Tant qu'un service n'a pas sa propre entrée, les agents voient son conteneur mais ignorent son adresse de santé, ses dépendances et la pile à laquelle il appartient.

## Service

- Nom : `<nom du service, tel que les gens le disent>`
- À quoi il sert, et qui l'utilise : `<une phrase>`
- Responsable à contacter : `<personne ou équipe>`
- Gravité d'une panne : `<bloque les clients / bloque l'équipe / peut attendre le matin>`

## Où il tourne

- Conteneur : `<nom exact tel que host.status l'affiche>`
- Pile : `<nom de pile accepté par host.redeploy, ou « aucune »>`
- Adresse de santé : `<https://... l'adresse que http.check doit appeler>` ; en bonne santé signifie `<statut 200>`
- Dépend de : `<autres conteneurs ou services externes, chacun avec son adresse de santé>`

L'hôte de chaque adresse de santé doit figurer sous `network` dans la copie de l'outil `http.check` propre à l'espace de travail, sinon la vérification ne peut pas l'atteindre.

## État normal

- `<ce que host.status affiche quand tout va bien : running, actif depuis des jours>`
- `<temps de réponse habituel de l'adresse de santé>`
- `<lignes de journal qui semblent alarmantes mais sont normales>`

## Pannes connues

Répétez ce bloc pour chaque panne déjà rencontrée.

- Symptôme : `<ce que montrent la vérification ou le journal>`
- Cause : `<ce qui se cachait derrière>`
- Correctif : `<l'action qui a fonctionné>`
- Un redémarrage aide-t-il : `<oui / non / seulement un temps>`

## Actions sûres

- Redémarrage : `<sûr à tout moment / interrompt les utilisateurs environ N secondes / jamais pendant ...>`
- Redéploiement : `<quand il est approprié, et ce qu'il interrompt>`
- Vérifier ensuite : `<la vérification qui doit réussir, et combien de temps attendre avant de la lancer>`

## Seule une personne fait cela

`<Actions que les agents ne doivent jamais tenter et doivent confier au responsable avec les preuves : restaurer une sauvegarde, supprimer des données ou des volumes, modifier la configuration ou les secrets, tout ce qui touche un autre hôte.>`
