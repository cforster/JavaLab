var flatiron = require('flatiron');
var app = flatiron.app;

var async = require('async');
var fs = require('fs');
var mongo = require('mongodb');
var path = require('path');
var shareClient = require('share').client;

var mongoServer = new mongo.Server('localhost', 27017, {auto_reconnect: true});
var mongoDb = new mongo.Db('javalab', mongoServer, {safe: true});

function readLab(labName, callback) {
  fs.readFile(path.join('labs', labName, 'lab.json'), function(e, data) {
    if (e) return callback(e);
    try {
      var lab = JSON.parse(data);
    } catch (e) {
      return callback(e);
    }
    async.map(lab.parts, function(partFile, done) {
      fs.readFile(path.join('labs', labName, partFile), done);
    }, function(e, results) {
      if (e) return callback(e);
      var parts = [];
      for (var i = 0; i < results.length; i++) {
        parts.push({'name': lab.parts[i], 'text': results[i]});
      }
      return callback(null, parts);
    });
  });
}

function openUserLabs(callback) {
  mongoDb.open(function(e, db) {
    if (e) return callback(e);
    db.collection('userlabs', function(e, collection) {
      if (e) {
        db.close();
        return callback(e);
      }
      return callback(null, db, collection);
    });
  });
}

function readUserLab(user, labName, callback) {
  openUserLabs(function(e, db, collection) {
    if (e) return callback(e);
    collection.findOne({user: user, labName: labName}, function(e, item) {
      db.close();
      if (e) return callback(e);
      return callback(null, item);
    });
  });
}

function createUserLab(user, labName, labParts, callback) {
  openUserLabs(function(e, db, collection) {
    if (e) return callback(e);
    collection.insert(
      {user: user, labName: labName, labParts: labParts},
      {safe: true},
      function(e, result) {
        db.close();
        return callback(e);
      });
  });
}

function populateDocs(user, labName, labParts, callback) {
  async.forEach(labParts, function(part, done) {
    var docName = user + ':' + labName + ':' + part.name;
    shareClient.open(
      docName,
      'text', 
      'http://localhost:' + app.config.get('httpPort') + '/channel',
      function(e, doc) {
        if (e) return done(e);
        if (!doc.getText()) {
          doc.insert(0, String(part.text), function(e, appliedOp) {
            doc.close();
            return done(e);
          });
        } else {
          doc.close();
          return done();
        }
      });
  }, callback);
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
        populateDocs(user, labName, labPartData, function(e) {
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
  openUserLabs(function(e, db, collection) {
    if (e) return callback(e);
    collection.update(
      {user: user, labName: labName},
      {$set: {labParts: labParts}},
      {safe: true},
      function(e, result) {
        db.close();
        return callback(e);
      });
  });
}