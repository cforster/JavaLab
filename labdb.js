var async = require('async');
var fs = require('fs');
var mongo = require('mongodb');
var path = require('path');
var shareClient = require('share').client;
var util = require('util');

var mongoDbHost = process.env.npm_package_config_mongoDbHost || 'localhost';
var mongoDbPort = Number(process.env.npm_package_config_mongoDbPort) || 27017;
var mongoServer = new mongo.Server(mongoDbHost, mongoDbPort,
                                   {auto_reconnect: true});
var mongoDb = new mongo.Db('javalab', mongoServer, {safe: true});

var db = null;
mongoDb.open(function(e, dbOpened) {
  if (e) throw ('Failed to connect to MongoDB at ' +
                mongoDbHost + ':' + mongoDbPort + '\n' + e);
  util.log('Connected to MongoDB at ' + mongoDbHost + ':' + mongoDbPort);
  db = dbOpened;
});

exports.readLabPart = function(labName, partName, callback) {
  fs.readFile(path.join('labs', labName, partName), callback);
}

function readLab(labName, callback) {
  fs.readFile(path.join('labs', labName, 'lab.json'), function(e, data) {
    if (e) return callback(e);
    try {
      var lab = JSON.parse(data);
    } catch (e) {
      return callback(e);
    }
    async.map(lab.parts, function(partFile, done) {
      exports.readLabPart(labName, partFile, done);
    }, function(e, results) {
      if (e) return callback(e);
      var parts = [];
      for (var i = 0; i < results.length; i++) {
        parts.push({name: lab.parts[i], text: results[i]});
      }
      return callback(null, parts);
    });
  });
}

function readUserLab(user, labName, callback) {
  db.collection('userlabs', function(e, collection) {
    if (e) return callback(e);
    collection.findOne({user: user, labName: labName}, callback);
  });
}

function createUserLab(user, labName, labParts, callback) {
  db.collection('userlabs', function(e, collection) {
    if (e) return callback(e);
    collection.insert(
      {user: user, labName: labName, labParts: labParts},
      {safe: true},
      function(e, result) {
        return callback(e);
      });
  });
}

var shareServerUrl =
  'ws://localhost:' +
  (process.env.npm_package_config_port || '80') +
  '/shareserver';
exports.populateLabPart = function(user, labName, partName, src, force, callback) {
  var docName = user + ':' + labName + ':' + partName;
  shareClient.open(docName, 'text', shareServerUrl, function(e, doc) {
    if (e) return callback(e);
    var text = doc.getText();
    if (force && text) {
      doc.del(0, text.length, function(e, appliedOp) {
        if (e) util.log('populateLabPart delete text failed: ' + e);
      });
      text = doc.getText();
    }
    if (!text) {
      doc.insert(0, String(src), function(e, appliedOp) {
        doc.close();
        return callback(e);
      });
    } else {
      doc.close();
      return callback();
    }
  });
}

exports.getOrCreateUserLab = function(user, labName, callback) {
  readUserLab(user, labName, function(e, item) {
    if (e) return callback(e);
    if (item) return callback(null, item);

    // user lab does not exist in DB, create it
    readLab(labName, function(e, labPartData) {
      if (e) return callback(e);
      var partNames = [];
      for (var i = 0; i < labPartData.length; i++) {
        partNames.push(labPartData[i].name);
      }
      createUserLab(user, labName, partNames, function(e) {
        if (e) return callback(e);     
        async.forEach(labPartData, function(part, done) {
          exports.populateLabPart(
            user, labName, part.name, part.text, false, done);
        }, function(e) {
          if (e) return callback(e);
          readUserLab(user, labName, function(e, item) {
            if (e) return callback(e);
            return callback(null, item);
          });
        });
      });
    });
  });
}

exports.updateUserLab = function(user, labName, labParts, callback) {
  db.collection('userlabs', function(e, collection) {
    if (e) return callback(e);
    collection.update(
      {user: user, labName: labName},
      {$set: {labParts: labParts}},
      {safe: true},
      function(e, result) {
        return callback(e);
      });
  });
}

exports.listLabs = function(callback) {
  fs.readdir('labs', callback);
}