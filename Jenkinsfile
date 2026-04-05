/*
  Jenkins declarative pipeline: verify client build, build Docker image, optional push.

  Agent requirements:
  - Docker CLI and access to a Docker daemon for the "Docker build" stage.

  Optional image push (CD):
  - Job / folder environment:
      DOCKER_REGISTRY   Full image prefix without image name, e.g. ghcr.io/myorg or docker.io/myuser
  - Credentials (username/password) with ID "docker-registry", or set DOCKER_REGISTRY_CREDS_ID.
  - Push runs only for branches main or master (edit the "when" block to match your workflow).

  Optional flags:
      SKIP_CLIENT_VERIFY = true   # skip npm ci + client build on the agent
      SKIP_DOCKER_PUSH   = true   # never push, even on main/master
*/

pipeline {
  agent any

  options {
    buildDiscarder(logRotator(numToKeepStr: '20'))
    timestamps()
    disableConcurrentBuilds(abortPrevious: true)
  }

  environment {
    DOCKER_BUILDKIT = '1'
    IMAGE_NAME = "${env.IMAGE_NAME ?: 'media-streaming'}"
    GIT_SHORT = "${env.GIT_COMMIT ? env.GIT_COMMIT.take(7) : 'nogit'}"
    TAG = "${env.BRANCH_NAME ?: 'unknown'}-${env.BUILD_NUMBER}-${GIT_SHORT}"
    LOCAL_IMAGE = "${IMAGE_NAME}:${TAG}"
    REGISTRY_CREDS = "${env.DOCKER_REGISTRY_CREDS_ID ?: 'docker-registry'}"
  }

  stages {
    stage('Checkout') {
      steps {
        checkout scm
      }
    }

    stage('Verify client build') {
      when {
        expression { return env.SKIP_CLIENT_VERIFY != 'true' }
      }
      agent {
        docker {
          image 'node:20-bookworm-slim'
          reuseNode true
        }
      }
      steps {
        dir('client') {
          sh 'npm ci'
          sh 'npm run build'
        }
      }
    }

    stage('Docker build') {
      steps {
        sh "docker build -t ${env.LOCAL_IMAGE} ."
        sh "docker tag ${env.LOCAL_IMAGE} ${env.IMAGE_NAME}:latest"
      }
    }

    stage('Docker push') {
      when {
        allOf {
          expression { env.SKIP_DOCKER_PUSH != 'true' }
          expression { env.DOCKER_REGISTRY?.trim() }
          anyOf {
            branch 'main'
            branch 'master'
          }
        }
      }
      steps {
        script {
          def remoteImage = "${env.DOCKER_REGISTRY}/${env.IMAGE_NAME}"
          withCredentials([
            usernamePassword(
              credentialsId: env.REGISTRY_CREDS,
              usernameVariable: 'DOCKER_USER',
              passwordVariable: 'DOCKER_PASS',
            ),
          ]) {
            sh """
              set -e
              REMOTE='${remoteImage}'
              TAG='${env.TAG}'
              LOCAL='${env.LOCAL_IMAGE}'
              LOGIN_HOST="\${DOCKER_LOGIN_HOST:-\$(echo -n '${env.DOCKER_REGISTRY}' | cut -d/ -f1)}"
              docker tag "\$LOCAL" "\$REMOTE:\$TAG"
              docker tag "\$LOCAL" "\$REMOTE:latest"
              echo "\$DOCKER_PASS" | docker login "\$LOGIN_HOST" -u "\$DOCKER_USER" --password-stdin
              docker push "\$REMOTE:\$TAG"
              docker push "\$REMOTE:latest"
            """
          }
        }
      }
    }
  }

  post {
    success {
      echo "Built image: ${env.LOCAL_IMAGE} (also ${env.IMAGE_NAME}:latest)"
    }
  }
}
