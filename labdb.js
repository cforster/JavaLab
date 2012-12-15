var _ = require('underscore')._;
var async = require('async');
var events = require('events');
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

exports.eventEmitter = new events.EventEmitter();

var db = null;
exports.open = function() {
  mongoDb.open(function(e, dbOpened) {
    if (e) throw ('Failed to connect to MongoDB at ' +
                  mongoDbHost + ':' + mongoDbPort + '\n' + e);
    util.log('Connected to MongoDB at ' + mongoDbHost + ':' + mongoDbPort);
    db = dbOpened;
    exports.eventEmitter.emit('open');
  });
}

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
        parts.push({name: lab.parts[i], text: results[i], predefined: true});
      }
      return callback(null, parts);
    });
  });
}

function readHomeLab(home, labName, callback) {
  db.collection('homelabs', function(e, collection) {
    if (e) return callback(e);
    collection.findOne({home: home, labName: labName}, callback);
  });
}

function createHomeLab(home, labName, labParts, callback) {
  db.collection('homelabs', function(e, collection) {
    if (e) return callback(e);
    collection.insert(
      {home: home, labName: labName, labParts: labParts},
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
exports.populateLabPart = function(home, labName, partName, src, force, callback) {
  var docName = home + ':' + labName + ':' + partName;
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

var homeLabCallback = {};
exports.getOrCreateHomeLab = function(home, labName, callback) {
  readHomeLab(home, labName, function(e, item) {
    if (e) return callback(e);
    if (item) return callback(null, item);

    var homeLabKey = home + ':' + labName;
    if (homeLabCallback[homeLabKey] == undefined) {
      homeLabCallback[homeLabKey] = [];
    } else {
      homeLabCallback[homeLabKey].push(function() {
        exports.getOrCreateHomeLab(home, labName, callback);
      });
      return;
    }

    // home lab does not exist in DB, create it
    readLab(labName, function(e, labPartData) {
      if (e) return callback(e);
      var parts = [];
      for (var i = 0; i < labPartData.length; i++) {
        parts.push({name: labPartData[i].name,
                    predefined: labPartData[i].predefined});
      }
      createHomeLab(home, labName, parts, function(e) {
        if (e) return callback(e);     
        async.forEach(labPartData, function(part, done) {
          exports.populateLabPart(
            home, labName, part.name, part.text, false, done);
        }, function(e) {
          if (e) return callback(e);
          readHomeLab(home, labName, function(e, item) {
            if (e) return callback(e);
            _.each(homeLabCallback[homeLabKey], function(f) {
              f();
            });
            delete homeLabCallback[homeLabKey];
            return callback(null, item);
          });
        });
      });
    });
  });
}

exports.updateHomeLab = function(home, labName, labParts, callback) {
  db.collection('homelabs', function(e, collection) {
    if (e) return callback(e);
    collection.update(
      {home: home, labName: labName},
      {$set: {labParts: labParts}},
      {safe: true},
      function(e, result) {
        return callback(e);
      });
  });
}

exports.listHomes = function(callback) {
  db.collection('homelabs', function(e, collection) {
    if (e) return callback(e);
    collection.distinct('home', function(e, result) {
      if (e) return callback(e);
      return callback(null, result);
    });
  });
}

exports.listLabs = function(callback) {
  fs.readdir('labs', callback);
}

exports.getUser = function(user, callback) {
  db.collection('users', function(e, collection) {
    if (e) return callback(e);
    collection.findOne({user: user}, function(e, item) {
      if (e) return callback(e);
      if (item) return callback(null, item);
      return callback(null, {user: user});
    });
  });
}

exports.updateUser = function(item, callback) {
  db.collection('users', function(e, collection) {
    if (e) return callback(e);
    collection.update({user: item.user}, item, {upsert: true}, function(e, result) {
      return callback(e);
    });
  });
}