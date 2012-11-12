function LabCtrl($scope) {
  $scope.user = '';
  $scope.labs = [];
  $scope.lab = null;
  $scope.servermsg = 'disconnected';

  var socket = new WebSocket('ws://' + document.location.host + '/labserver');
  socket.onopen = function(event) {
    $scope.$apply(function() {
      $scope.servermsg = 'idle';
    });
  }
  socket.onmessage = function(event) {
    $scope.$apply(function() {
      var r = JSON.parse(event.data);
      switch (r.type) {
      case 'error':
        console.log(r.text);
        break;
      case 'state':
        $scope.servermsg = r.state;
        if (r.state == 'run') {
          clearTerm();
          $('#footertabs a[href="#output-tab"]').tab('show');
          $scope.errors = [];
          $scope.selectedError = null
        }
        break;
      case 'updateLabs':
        $scope.labs = r.labs;
        if (!$scope.lab) {
          $scope.lab = $scope.labs[0] || null;
        }
        break;
      case 'updateLabParts':
        $scope.parts = [];
        for (var i = 0; i < r.labParts.length; i++) {
          $scope.parts.push({name: r.labParts[i]});
        }
        if ($scope.activePart) {
          var activePartIndex = r.labParts.indexOf($scope.activePart.name);
          if (activePartIndex != -1) {
            $scope.switchPart($scope.parts[activePartIndex]);
          } else {
            $scope.switchPart($scope.parts[0] || null);
          }
        } else {
          $scope.switchPart($scope.parts[0] || null);
        }
        break;
      case 'compileErrors':
        $scope.errors = r.compileErrors;
        $scope.selectedError = $scope.errors[0] || null;
        $('#footertabs a[href="#errors-tab"]').tab('show');
        $scope.onErrorSelect();
        break;
      case 'stdout':
        termStdout(r.stdout);
        break;
      }
    });
  }
  socket.onerror = socket.onclose = function(event) {
    $scope.$apply(function() {
      $scope.servermsg = 'disconnected';
      $scope.editor.setReadOnly(true);
    });
  }

  $scope.errors = [];
  $scope.selectedError = null;
  $scope.onErrorSelect = function() {
    $scope.editor.gotoLine($scope.selectedError.line, $scope.selectedError.col);
  }

  var editorDoc = null;
  $scope.newPartPattern = /^[A-Za-z0-9]*$/;
  $scope.parts = [];
  $scope.activePart = null;
  $scope.switchPart = function(part) {
    if (!$scope.user || socket.readyState != 1) return;
    if (part && editorDoc && $scope.activePart &&
        $scope.activePart.name == part.name) {
      return;
    }
    $scope.errors = [];
    $scope.selectedError = null;
    $scope.activePart = part;
    if (part == null) {
      if (editorDoc) {
        editorDoc.detach_ace();
        $scope.editor.setReadOnly(true);
        $scope.editor.setValue('No part selected');
        editorDoc.close();
        editorDoc = null;
      }
    } else {
      function openDoc() {
        $scope.editor.setValue('Loading...');
        sharejs.open(
          $scope.user + ':' + $scope.lab + ':' + part.name,
          'text',
          function(e, doc) {
            if (e) return console.log(e);
            editorDoc = doc;
            doc.attach_ace($scope.editor);
            $scope.editor.gotoLine(1, 0, false);
            $scope.editor.scrollToRow(0);
            $scope.editor.setReadOnly(false);
          });
      }
      if (editorDoc) {
        editorDoc.detach_ace();
        $scope.editor.setReadOnly(true);
        $scope.editor.setValue('Loading...');
        editorDoc.close(openDoc);
        editorDoc = null;
      } else {
        openDoc();
      }
    }
  }
  $scope.removePart = function(part) {
    if (!$scope.user || socket.readyState != 1) return;
    socket.send(JSON.stringify({type: 'deleteLabPart', partName: part.name}));
    var i = $scope.parts.indexOf(part);
    $scope.parts.splice(i, 1);
    if ($scope.activePart == part) {
      if (i == $scope.parts.length) i--;
      $scope.switchPart($scope.parts.length == 0 ? null : $scope.parts[i]);
    }
  }
  $scope.newPart = function() {
    if (!$scope.user || socket.readyState != 1) return;
    if (newPartForm.$invalid || !$scope.newPartName)
      return;

    var unique = true;
    angular.forEach($scope.parts, function(part) {
      if (part.name == $scope.newPartName) unique = false;
    });
    if (!unique) {
      $scope.newPartName = '';
      return;
    }

    socket.send(JSON.stringify(
      {type: 'addLabPart', partName: $scope.newPartName}));
    var newPart = {name: $scope.newPartName};
    $scope.newPartName = '';
    $scope.parts.push(newPart);
    $scope.switchPart(newPart);
  }

  $scope.switchLab = function() {
    $('#loginModal').modal();
  }

  $scope.login = function() {
    $scope.switchPart(null);
    socket.send(JSON.stringify({type: 'setUser', user: $scope.user}));
    socket.send(JSON.stringify({type: 'setLab', lab: $scope.lab}));
    $('#loginModal').modal('hide');
  }

  $scope.run = function() {
    if (!$scope.user || socket.readyState != 1) return;
    var src = $scope.editor.getValue();
    socket.send(JSON.stringify({type: 'compileRun', src: src}));
  }

  $scope.stop = function() {
    if (!$scope.user || socket.readyState != 1) return;
    socket.send(JSON.stringify({type: 'stop'}));
  }

  $scope.initEditor = function() {
    $scope.editor = ace.edit('editor');
    $scope.editor.setTheme('ace/theme/chrome');
    $scope.editor.getSession().setMode('ace/mode/java');
    $scope.editor.setPrintMarginColumn(100);
    $scope.editor.getSession().setUseSoftTabs(true);
    $scope.editor.getSession().setTabSize(2);
    $scope.editor.setValue('No part loaded');
    $scope.editor.setReadOnly(true);
  }

  var termStdinStart = 0;
  function clearTerm() {
    var term = $('#terminal')[0];
    term.value = '';
    termStdinStart = 0;
  }
  function termStdout(stdoutData) {
    var term = $('#terminal')[0];
    var stdinData = '';
    if (term.value.length > termStdinStart) {
      stdinData = term.value.substr(termStdinStart);
      term.value = term.value.substring(0, termStdinStart);
    }
    term.value += stdoutData;
    termStdinStart += stdoutData.length;
    if (stdinData) {
      term.value += stdinData;
    }
    term.scrollTop = term.scrollHeight;
  }
  $scope.initTerminal = function() {
    clearTerm();
    var term = $('#terminal')[0];
    $('#terminal').keydown(function(event) {
      // TODO: handle delete character, not just backspace
      if (event.which == 8) {
        if ($scope.servermsg != 'run') {
          event.preventDefault();
          return;
        }
        if (term.value.length > termStdinStart) {
          term.value = term.value.substring(0, term.value.length - 1);
        }
        term.scrollTop = term.scrollHeight;
        event.preventDefault();
      } else if (event.which == 13) {
        if ($scope.servermsg != 'run') {
          event.preventDefault();
          return;
        }
        term.value += '\n';
        var stdinData = term.value.substr(termStdinStart);
        termStdinStart = term.value.length;
        if (socket.readyState == 1) {
          socket.send(JSON.stringify({type: 'stdin', stdin: stdinData}));
        }
        term.scrollTop = term.scrollHeight;
        event.preventDefault();
      }
    });
    $('#terminal').keypress(function(event) {
      if (event.which > 31 && event.which < 127) {
        if ($scope.servermsg != 'run') {
          event.preventDefault();
          return;
        }
        term.value += String.fromCharCode(event.which);
        term.scrollTop = term.scrollHeight;
        event.preventDefault();
      }
    });
    $('#terminal').bind('paste', function(event) {
      event.preventDefault();
    });
  }
}

$(window).load(function() {
  $('#loginModal').modal();
});
