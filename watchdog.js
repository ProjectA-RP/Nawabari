/* Configuation */
const { 
    secret, 
    port, 
    syncAccountName, 
    sync,
    commitPrefix
} = require('./config.json');
if (!secret || !port || !syncAccountName || !sync || !commitPrefix) { return; }

/* Dependencies */
const path = require('path');
const async = require('async');
const Base64 = require('js-base64').Base64;
const { Webhooks } = require("@octokit/webhooks");

/* Components */
const { 
    getContents,
    push,
    createBlob
} = require('./Components/Github');

/* Helpers */
const { logInfo, logOk, logWarn, logError } = require('./Helpers/Logger');

/* Variable */
const webhooks = new Webhooks({
    secret: secret
});

/* Function */
function changedFiles(files) {
    let commits = [];
    let tree = {
        owner: sync.destination.owner,
        repo: sync.destination.repository,
        branch: sync.destination.branch,
        changes : {
            files: {},
            commit: ''
        }
    }

    async.each(files, function(data, cb) {
        if (commits.indexOf(data.commit) == -1) {
            commits.push(data.commit);
        }

        let changes = null;

        if (data.data) {
            changes = Base64.decode(data.data);
        }

        tree.changes.files[path.join(sync.destination.dist, data.path).replace(/\\/g, "/")] = changes;
        cb();
    }, async function() {
        tree.changes.commit = `${commitPrefix} Sync (${commits.join(", ")})`
        return await push(tree);
    });
}

/* Event */
webhooks.on("push", ({ id, name, payload }) => {
    let owner = payload.repository.owner.name;
    let repo = payload.repository.name;

    if (owner !== sync.source.owner || repo !== sync.source.repository) { return; }

    let signature = webhooks.sign(payload);
    let verify = webhooks.verify(payload, signature);
    if (!verify) { return; }

    logInfo(`Got the push event (${id})`, 'webhooks');
    if (payload.pusher.name.toLowerCase() === syncAccountName.toLowerCase()) { return; }
    
    let commits = payload.commits;
    if (commits.length <= 0) { return; }

    let Filestochange = [];

    async.eachLimit(commits, 1, function(commit, cb) {
        let prepare = {
            modified: commit.modified,
            removed: commit.removed,
            added: commit.added
        }

        if (prepare.modified.length <= 0 && prepare.removed.length <= 0 && prepare.added.length <= 0) { return cb(); }

        async.parallel([
            function(callback) {
                async.each(prepare.removed, function(path, cb) {
                    Filestochange.push({ 
                        path: path,
                        commit: commit.id.substring(0,7), 
                        data: null
                    });
                    
                    cb();
                }, callback);
            },
            function(callback) { 
                let merge = prepare.modified.concat(prepare.added);

                async.eachLimit(merge, 1, function(path, cb) {
                    getContents({ 
                        owner: owner,
                        repo: repo,
                        path: path,
                    }, function(res) {
                        if (res.success && res.path && res.data) {
                            Filestochange.push({ 
                                path: res.path,
                                commit: commit.id.substring(0,7), 
                                data: res.data
                            });
                        } else {
                            //TODO: Send discord alert
                            logError(`Error while pulling contents : ${res.message} | (Files : ${res.path})`, 'getContents')
                        }
        
                        cb();
                    });
                }, callback)
            }
        ], function() {
            cb();
        });
    }, function(res) {
        changedFiles(Filestochange);
    });
});

/* Listener */
require("http").createServer(webhooks.middleware).listen(port);
